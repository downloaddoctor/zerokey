const express = require('express')
const { ClaudeAPI } = require('../core/claude/api')
const { claudeStreamHandler } = require('../core/claude/stream-handler')
const { toOpenAIError } = require('../utils/errors')
const ToolCompiler = require('../lib/engine')
const { setClaudeInstructions } = require('../core/claude/set-instructions')

const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-6'

const claudeApi = new ClaudeAPI()
const { acquireSlot } = require('../utils/rate-limiter')

async function buildClaudeRouter(parsedFetch, session, userData = null) {
  if (!parsedFetch || !parsedFetch.headers) {
    throw new Error('parsedFetch with headers is required')
  }

  console.log('[Claude] Initializing from parsed capture JSON')
  await claudeApi.initializeFromJSON(parsedFetch)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [] } = req.body
    const disableTools = session.disableTools || false
    const model = session.model || CLAUDE_DEFAULT_MODEL

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

    const compiler = new ToolCompiler(req.ide, 'claude')
    const isNewSession = session.parentMessageId == null

    const { dynamicGrammar } = compiler.syncDynamicTools(req.body.tools || [], session)

    const prompt = compiler.formatPrompt(messages, isNewSession)

    if (isNewSession) {
      await setClaudeInstructions(claudeApi, userData, dynamicGrammar, disableTools)
    }

    await acquireSlot('Claude')

    try {
      const { stream, chatSessionId } = await claudeApi.chatCompletion(
        prompt,
        session.chatSessionId,
        session.parentMessageId,
        model,
        [],
      )

      if (chatSessionId && !session.chatSessionId) {
        session.chatSessionId = chatSessionId
      }

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Access-Control-Allow-Origin', '*')

      const parser = new ToolCompiler.Stream(res, 'claude', compiler, session)

      await claudeStreamHandler(res, stream, session, parser)
    } catch (error) {
      if (res.headersSent) return
      console.error('[Claude Route] Error:', error.message)

      const err = toOpenAIError(error, 'Claude')
      return res.status(err.error.status || 500).json(err)
    }
  })

  return router
}

module.exports = { buildClaudeRouter }
