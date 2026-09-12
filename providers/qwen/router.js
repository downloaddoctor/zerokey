const express = require('express')

const { StreamPipeline } = require('../../engine/pipeline')
const { QwenAPI } = require('./api')
const { streamHandler } = require('./stream-handler')
const { setQwenInstructions } = require('./set-instructions')
const { acquireSlot } = require('../../utils/rate-limiter')
const { validateMessages } = require('../../utils/route-helpers')

const qwenApi = new QwenAPI()

async function buildQwenRouter(parsedFetch, session, userData = null) {
  console.debug('[Qwen] Initializing from parsed capture JSON')
  await qwenApi.initializeFromJSON(parsedFetch)

  if (!session) throw new Error('No session provided')

  if (!session.chatSessionId) {
    const chatId = await qwenApi.createChatSession(session.model || 'qwen3.7-max')
    session.chatSessionId = chatId
  }

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [], tools } = req.body
    if (!validateMessages(messages, res)) return

    StreamPipeline.setSSEHeaders(res)
    const pipeline = new StreamPipeline(res, session, 'qwen', req.ide, messages)
    const activeSession = pipeline.session

    if (pipeline.isNewSession && !pipeline.rawMode) {
      await setQwenInstructions(qwenApi, userData, pipeline.toolCalling)
      pipeline.haveInstructionsAPI = true
    }

    if (!activeSession.chatSessionId) {
      activeSession.chatSessionId = await qwenApi.createChatSession(
        activeSession.model || 'qwen3.7-max',
      )
    }

    const fileIds = []
    pipeline.bindUploader(qwenApi, fileIds)

    const { prompt, handled } = await pipeline.setup(messages, tools, req)
    if (handled) return

    if (pipeline.ephemeralMode) {
      pipeline.onFinalChunk = () => {
        if (activeSession.chatSessionId) {
          qwenApi.deleteSession(activeSession.chatSessionId).catch(() => {})
        }
      }
    }

    try {
      await acquireSlot('Qwen')
      const qwenStream = await qwenApi.chatCompletion(
        activeSession.chatSessionId,
        prompt,
        activeSession.parentMessageId,
        { model: activeSession.model },
      )

      const retry = async () => {
        await acquireSlot('Qwen', true)
        return qwenApi.chatCompletion(
          activeSession.chatSessionId,
          prompt,
          activeSession.parentMessageId,
          { model: activeSession.model },
        )
      }

      streamHandler(qwenStream, activeSession, pipeline, retry)
    } catch (error) {
      if (error?.code === 'RateLimited' && userData) {
        const waitMs = typeof error.waitMs === 'number' ? error.waitMs : 24 * 60 * 60 * 1000
        userData.waitUntil = Date.now() + waitMs
        userData.waitReason = 'daily_limit'
      }
      return pipeline.onError(error)
    }
  })

  return router
}

module.exports = { buildQwenRouter }
