const express = require('express')
const { DeepSeekAPI } = require('../core/deepseek/api')
const { toOpenAIError } = require('../utils/errors')
const { streamHandler } = require('../core/deepseek/stream-handler')
const ToolCompiler = require('../lib/engine')
const { acquireSlot } = require('../utils/rate-limiter')

const deepseekApi = new DeepSeekAPI()

async function buildChatRouter(headers, session) {
  await initDeepSeekAPI(session, headers)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [] } = req.body
    const disableTools = session.disableTools || false

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

    const compiler = new ToolCompiler(req.ide, 'deepseek')
    const isNewSession = session.parentMessageId == null

    const { dynamicGrammar } = compiler.syncDynamicTools(req.body.tools || [], session)

    let prompt = compiler.formatPrompt(messages, isNewSession)
    let model_type = null

    if (isNewSession) {
      prompt = disableTools ? prompt : compiler.buildPrompt(prompt, dynamicGrammar)
      model_type = 'expert'
    }

    await acquireSlot('DeepSeek')

    try {
      const deepseekStream = await deepseekApi.chatCompletion(
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
          session.chatSessionId,
          prompt,
          session.parentMessageId,
          false,
          true,
          model_type,
        )
      }

      streamHandler(res, deepseekStream, session, parser, retry)
    } catch (error) {
      if (res.headersSent) return
      console.error('[DeepSeek Route] Error:', error.message)
      const err = toOpenAIError(error, 'DeepSeek')
      return res.status(err.error.status || 500).json(err)
    }
  })

  return router
}

async function initDeepSeekAPI(session, headers) {
  await deepseekApi.initialize(headers)
  console.log('[API] initialized successfully')

  if (!session) throw new Error('No session provided')

  if (session.chatSessionId) {
    return console.log(
      `[CHAT] Using session: "${session.name}" (chatSessionId: ${session.chatSessionId})`,
    )
  }

  const chatSessionId = await deepseekApi.createChatSession()
  session.chatSessionId = chatSessionId
  console.log(`[CHAT] Session "${session.name}" created with chatSessionId: ${chatSessionId}`)
}

module.exports = { buildChatRouter, initDeepSeekAPI }
