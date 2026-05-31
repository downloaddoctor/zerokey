const express = require('express')
const { DeepSeekAPI } = require('../core/deepseek/api')
const { toOpenAIError } = require('../utils/errors')
const { streamHandler } = require('../core/deepseek/stream-handler')
const ToolCompiler = require('../lib/engine')
const { acquireSlot } = require('../utils/rate-limiter')

const deepseekApi = new DeepSeekAPI()

/**
 * Build the chat router with pre-resolved model + session baked in via closure.
 * IDE extracted per-request from Authorization: Bearer <ide> header (req.ide).
 */
async function buildChatRouter(headers, session, saveSession) {
  if (!saveSession) saveSession = () => {}
  await initDeepSeekAPI(session, headers, saveSession)

  const router = express.Router()

  // POST /v1/chat/completions
  router.post('/', async (req, res) => {
    const { messages = [], tools } = req.body
    // require('fs').writeFile('temp/tools.json', JSON.stringify(tools, null, 1), () => {})

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
    const compiler = new ToolCompiler(req.ide, 'deepseek')
    let prompt = compiler.formatPrompt(messages)
    let model_type = null

    if (!session.parentMessageId) {
      prompt = compiler.buildPrompt(prompt)
      model_type = 'expert'
    }

    await acquireSlot('DeepSeek')

    try {
      const deepseekStream = await deepseekApi.chatCompletion(
        headers,
        session.chatSessionId,
        prompt,
        session.parentMessageId,
        false,
        true,
        model_type,
      )

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Access-Control-Allow-Origin', '*')

      const parser = new ToolCompiler.Stream(res, 'deepseek', compiler, session)

      const retry = async () => {
        await acquireSlot('DeepSeek', true)
        return deepseekApi.chatCompletion(
          headers,
          session.chatSessionId,
          prompt,
          session.parentMessageId,
          false,
          true,
          model_type,
        )
      }

      streamHandler(res, deepseekStream, session, parser, saveSession, retry)
    } catch (error) {
      console.error('[DeepSeek Route] Error:', error.message)
      const err = toOpenAIError(error, 'DeepSeek')
      return res.status(err.error.status || 500).json(err)
    }
  })

  return router
}

/**
 * Initialize the DeepSeek API and resolve session.
 */
async function initDeepSeekAPI(session, headers, saveSession) {
  await deepseekApi.initialize(headers)
  console.log('[API] initialized successfully')

  if (!session) {
    throw new Error('No session provided')
  }

  if (session.chatSessionId) {
    return console.log(
      `[CHAT] Using session: "${session.name}" (chatSessionId: ${session.chatSessionId})`,
    )
  }

  const chatSessionId = await deepseekApi.createChatSession(headers)
  session.chatSessionId = chatSessionId
  saveSession()
  console.log(`[CHAT] Session "${session.name}" created with chatSessionId: ${chatSessionId}`)
}

module.exports = { buildChatRouter, initDeepSeekAPI }
