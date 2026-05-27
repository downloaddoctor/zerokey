const express = require('express')
const { ClaudeAPI } = require('../core/claude/api')
const { claudeStreamHandler } = require('../core/claude/stream-handler')
const { toOpenAIError } = require('../utils/errors')
const ToolCompiler = require('../lib/engine')

const claudeApi = new ClaudeAPI()

/**
 * Build the Claude router.
 * IDE extracted per-request from Authorization: Bearer <ide> header (req.ide).
 */
async function buildClaudeRouter(parsedFetch, session, saveSession) {
  if (!parsedFetch || !parsedFetch.headers) {
    throw new Error('parsedFetch with headers is required')
  }

  console.log('[Claude] Initializing from parsed capture JSON')
  await claudeApi.initializeFromJSON(parsedFetch)

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

    const model = 'claude-sonnet-4-6'

    // ToolCompiler created per-request with IDE from auth header
    const compiler = new ToolCompiler(req.ide)
    let prompt = compiler.formatPrompt(messages)

    // Prepend system prompt for first message in conversation
    if (!session.parentMessageId) {
      prompt = compiler.buildPrompt(prompt)
    }

    try {
      // No tools for now — Claude tools have different format
      const { stream, chatSessionId } = await claudeApi.chatCompletion(
        prompt,
        session.chatSessionId,
        session.parentMessageId,
        model,
        [],
      )

      // Save conversation ID immediately for multi-turn
      if (chatSessionId && !session.chatSessionId) {
        session.chatSessionId = chatSessionId
        saveSession()
      }

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Access-Control-Allow-Origin', '*')

      // Use ToolCompiler.Stream to parse tool calls from LLM output
      const parser = new ToolCompiler.Stream(res, 'claude', compiler)

      claudeStreamHandler(res, stream, session, saveSession, parser, claudeApi)
    } catch (error) {
      console.error('[Claude Route] Error:', error.message)
      const err = toOpenAIError(error, 'Claude')
      return res.status(err.error.status || 500).json(err)
    }
  })

  return router
}

module.exports = { buildClaudeRouter }
