const express = require('express')

const { StreamPipeline } = require('../../engine/pipeline')
const { ChatGPTAPI } = require('./api')
const { chatgptStreamHandler } = require('./stream-handler')
const { acquireSlot } = require('../../utils/rate-limiter')
const chatgptApi = new ChatGPTAPI()

async function buildChatGPTRouter(parsedFetch, session, _userData = null) {
  console.debug('[ChatGPT] Initializing from parsed capture JSON')
  await chatgptApi.initializeFromJSON(parsedFetch)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [], tools } = req.body
    const pipeline = new StreamPipeline(res, session, 'chatgpt', req.surface, req.isRealSession)
    const activeSession = pipeline.session
    const model = activeSession.model || 'auto'

    const attachments = []
    pipeline.bindUploader(chatgptApi, attachments)

    const { prompt, handled } = await pipeline.setup(messages, tools, req)
    if (handled) return

    if (pipeline.ephemeralMode) {
      pipeline.onFinalChunk = () => {
        if (activeSession.chatSessionId) {
          chatgptApi.deleteSession(activeSession.chatSessionId).catch(() => {})
        }
      }
    }

    await acquireSlot('ChatGPT')

    try {
      const stream = await chatgptApi.chatCompletion(
        prompt,
        activeSession.chatSessionId,
        activeSession.parentMessageId,
        model,
        attachments,
      )

      await chatgptStreamHandler(stream, activeSession, pipeline)
    } catch (error) {
      return pipeline.onError(error)
    }
  })

  return router
}

module.exports = { buildChatGPTRouter }
