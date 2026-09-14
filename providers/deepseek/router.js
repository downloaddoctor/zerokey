const express = require('express')

const { StreamPipeline } = require('../../engine/pipeline')
const { DeepSeekAPI } = require('./api')
const { streamHandler } = require('./stream-handler')
const { acquireSlot } = require('../../utils/rate-limiter')
const { validateMessages } = require('../../utils/route-helpers')
const { reasoning } = require('./config')

const deepseekApi = new DeepSeekAPI()

// O(1) reasoning_effort → { think, search } lookup.
// Keys are the exact labels VS Code advertises (utils/sync-ide-config.js).
// Anything not mapped disables both thinking and search.
const REASONING_MAP = reasoning.map

async function buildDeepSeekRouter(parsedFetch, session, userData) {
  console.debug('[Deepseek] Initializing from parsed capture JSON')
  await deepseekApi.initializeFromJSON(parsedFetch)

  if (!session) throw new Error('No session provided')

  if (!session.chatSessionId) {
    try {
      session.chatSessionId = await deepseekApi.createChatSession()
      await deepseekApi.warmupSession(session.chatSessionId)
    } catch (error) {
      if (error.code === 'account_suspended' && error.muteUntil != null && userData) {
        userData.waitUntil = Math.ceil(error.muteUntil * 1000)
        userData.waitReason = 'account_suspended'
      }
      throw error
    }
  }

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [], tools, reasoning_effort: reasoningEffort = null } = req.body
    if (!validateMessages(messages, res)) return

    StreamPipeline.setSSEHeaders(res)
    const pipeline = new StreamPipeline(res, session, 'deepseek', req.ide, messages)

    if (pipeline.ephemeralMode) {
      pipeline.sendFinalChunk()
      return
    }

    const activeSession = pipeline.session
    if (!activeSession.chatSessionId) {
      try {
        activeSession.chatSessionId = await deepseekApi.createChatSession()
        await deepseekApi.warmupSession(activeSession.chatSessionId)
      } catch (error) {
        if (error.code === 'account_suspended' && error.muteUntil && userData) {
          userData.waitUntil = Math.ceil(error.muteUntil * 1000)
          userData.waitReason = 'account_suspended'
        }
        return pipeline.onError(error)
      }
    }
    const modelType = pipeline.isNewSession ? activeSession.model || 'default' : null
    const { think: thinkingEnabled, search: searchEnabled } = REASONING_MAP[reasoningEffort] ?? {
      think: false,
      search: false,
    }

    const fileIds = []
    pipeline.bindUploader(deepseekApi, fileIds)

    const { prompt, handled } = await pipeline.setup(messages, tools, req)
    if (handled) return

    try {
      await acquireSlot('DeepSeek')
      const deepseekStream = await deepseekApi.chatCompletion(
        activeSession.chatSessionId,
        prompt,
        activeSession.parentMessageId,
        thinkingEnabled,
        searchEnabled,
        modelType,
        fileIds,
      )

      const retry = async () => {
        await acquireSlot('DeepSeek', true)
        return deepseekApi.chatCompletion(
          activeSession.chatSessionId,
          prompt,
          activeSession.parentMessageId,
          thinkingEnabled,
          searchEnabled,
          modelType,
          fileIds,
        )
      }

      streamHandler(deepseekStream, activeSession, pipeline, retry)
    } catch (error) {
      if (error.code === 'account_suspended' && error.muteUntil && userData) {
        userData.waitUntil = Math.ceil(error.muteUntil * 1000)
        userData.waitReason = 'account_suspended'
      }
      return pipeline.onError(error)
    }
  })

  return router
}

module.exports = { buildDeepSeekRouter }
