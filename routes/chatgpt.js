const express = require('express')
const { ChatGPTAPI } = require('../core/chatgpt/api')
const { chatgptStreamHandler } = require('../core/chatgpt/stream-handler')
const { toOpenAIError } = require('../utils/errors')
const ToolCompiler = require('../lib/engine')
const { acquireSlot } = require('../utils/rate-limiter')

const chatgptApi = new ChatGPTAPI()

/**
 * Build the ChatGPT router.
 * IDE extracted per-request from Authorization: Bearer <ide> header (req.ide).
 */
async function buildChatGPTRouter(parsedFetch, session, saveSession) {
  if (!parsedFetch || !parsedFetch.headers || !parsedFetch.body) {
    throw new Error('parsedFetch with headers and body is required')
  }

  console.log('[ChatGPT] Initializing from parsed fetch JSON')
  await chatgptApi.initializeFromJSON(parsedFetch)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [] } = req.body
    if (!messages || messages.length === 0) {
      return res
        .status(400)
        .json(
          toOpenAIError(
            400,
            'messages is required and must be a non-empty array',
            'invalid_request_error',
            'missing_messages',
          ),
        )
    }

    // ToolCompiler created per-request with IDE from auth header
    const compiler = new ToolCompiler(req.ide, 'chatgpt')
    let prompt = compiler.formatPrompt(messages)

    if (!session.parentMessageId) {
      prompt = compiler.buildPrompt(prompt)
    }

    await acquireSlot('ChatGPT')

    try {
      const stream = await chatgptApi.chatCompletion(
        prompt,
        session.chatSessionId,
        session.parentMessageId,
      )

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Access-Control-Allow-Origin', '*')

      // Use ToolCompiler.Stream to parse tool calls from LLM output
      const parser = new ToolCompiler.Stream(res, 'chatgpt', compiler)

      chatgptStreamHandler(res, stream, session, saveSession, parser)
    } catch (error) {
      console.error('[ChatGPT Route] Error:', error.message)
      const err = toOpenAIError(error, 'ChatGPT')
      return res.status(err.error.status || 500).json(err)
    }
  })

  return router
}

module.exports = { buildChatGPTRouter }
