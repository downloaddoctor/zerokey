const express = require('express')

const { StreamPipeline } = require('../engine/pipeline')
const { DeepSeekAPI } = require('../core/deepseek/api')
const { streamHandler } = require('../core/deepseek/stream-handler')
const { acquireSlot } = require('../utils/rate-limiter')
const { validateMessages } = require('../utils/route-helpers')

const deepseekApi = new DeepSeekAPI()

async function buildDeepSeekRouter(parsedFetch, session) {
  console.debug('[Deepseek] Initializing from parsed capture JSON')
  await deepseekApi.initializeFromJSON(parsedFetch)

  if (!session) throw new Error('No session provided')

  if (!session.chatSessionId) {
    const chatSessionId = await deepseekApi.createChatSession()
    session.chatSessionId = chatSessionId
  }

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [], tools } = req.body
    if (!validateMessages(messages, res)) return

    StreamPipeline.setSSEHeaders(res)
    const pipeline = new StreamPipeline(res, session, 'deepseek', req.ide, messages)
    const activeSession = pipeline.session
    if (!activeSession.chatSessionId) {
      activeSession.chatSessionId = await deepseekApi.createChatSession()
    }
    const modelType = pipeline.isNewSession ? activeSession.model || 'default' : null

    const fileIds = []
    pipeline.bindUploader(deepseekApi, fileIds)

    const { prompt, handled } = await pipeline.setup(messages, tools, req)
    if (handled) return

    if (pipeline.ephemeralMode) {
      pipeline.onFinalChunk = () => {
        if (activeSession.chatSessionId) {
          deepseekApi.deleteSession(activeSession.chatSessionId).catch(() => {})
        }
      }
    }

    try {
      await acquireSlot('DeepSeek')
      const deepseekStream = await deepseekApi.chatCompletion(
        activeSession.chatSessionId,
        prompt,
        activeSession.parentMessageId,
        false,
        true,
        modelType,
        fileIds,
      )

      const retry = async () => {
        await acquireSlot('DeepSeek', true)
        return deepseekApi.chatCompletion(
          activeSession.chatSessionId,
          prompt,
          activeSession.parentMessageId,
          false,
          true,
          modelType,
          fileIds,
        )
      }

      streamHandler(deepseekStream, activeSession, pipeline, retry)
    } catch (error) {
      return pipeline.onError(error)
    }
  })

  return router
}

module.exports = { buildDeepSeekRouter }
