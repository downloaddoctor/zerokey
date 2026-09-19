const express = require('express')

const { StreamPipeline } = require('../../engine/pipeline')
const { DeepSeekAPI } = require('./api')
const { getSharedTransport } = require('./browser-transport')
const { streamHandler } = require('./stream-handler')
const { acquireSlot } = require('../../utils/rate-limiter')
const { validateMessages } = require('../../utils/route-helpers')
const { reasoning } = require('./config')

// Transport selection: 'browser' (default) drives the real web UI; 'api' keeps
// the legacy direct-fetch path (PoW headers, cookie jar). Set via env when you
// need to compare or fall back. The transport singleton is resolved lazily
// inside buildDeepSeekRouter so it can be keyed to the selected local username
// (profile dir = temp/profiles/deepseek/<username>/) — never constructed at
// module load.
const TRANSPORT = (process.env.DEEPSEEK_TRANSPORT || 'browser').toLowerCase()

// O(1) reasoning_effort → { think, search } lookup.
// Keys are the exact labels VS Code advertises (utils/sync-ide-config.js).
// Anything not mapped disables both thinking and search.
const REASONING_MAP = reasoning.map

async function buildDeepSeekRouter(parsedFetch, session, userData) {
  const username = userData?.username
  if (TRANSPORT !== 'api' && !username) {
    throw new Error('[Deepseek] userData.username (local key) is required for browser transport')
  }
  const deepseekApi = TRANSPORT === 'api' ? new DeepSeekAPI() : getSharedTransport({ username })

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
