const express = require('express')
const { ClaudeAPI } = require('../core/claude/api')
const { claudeStreamHandler } = require('../core/claude/stream-handler')
const { toOpenAIError } = require('../utils/errors')
const ToolCompiler = require('../lib/engine')
const { setClaudeInstructions } = require('../core/claude/set-instructions')

const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-6'
const CLAUDE_FALLBACK_MODEL = 'claude-haiku-4-5-20251001'

const claudeApi = new ClaudeAPI()
const { acquireSlot } = require('../utils/rate-limiter')

function resolveClaudeModel(userData) {
  if (!userData) return CLAUDE_DEFAULT_MODEL

  const expiresAt = userData.modelFallbackExpiresAt
    ? Date.parse(userData.modelFallbackExpiresAt)
    : null
  const now = Date.now()

  if (expiresAt && expiresAt <= now) {
    if (userData.model === CLAUDE_FALLBACK_MODEL) {
      userData.model = CLAUDE_DEFAULT_MODEL
    }
    delete userData.modelFallbackExpiresAt
    delete userData.modelFallbackReason
    return userData.model || CLAUDE_DEFAULT_MODEL
  }

  if (expiresAt && expiresAt > now) {
    return CLAUDE_FALLBACK_MODEL
  }

  return userData.model || CLAUDE_DEFAULT_MODEL
}

/**
 * Build the Claude router.
 * IDE extracted per-request from Authorization: Bearer <ide> header (req.ide).
 */
async function buildClaudeRouter(parsedFetch, session, saveSession, userData = null) {
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

    const model = resolveClaudeModel(userData)

    // ToolCompiler created per-request with IDE from auth header
    const compiler = new ToolCompiler(req.ide, 'claude')
    const isNewSession = session.parentMessageId == null
    const prompt = compiler.formatPrompt(messages, isNewSession)

    // Sync instructions.md to Claude custom instructions on new session (hash-cached, fire-and-forget)
    // Do NOT prepend instructions.md to prompt — Claude receives it via account_profile API
    if (isNewSession) {
      await setClaudeInstructions(claudeApi, userData, saveSession)
    }

    await acquireSlot('Claude')

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
      const parser = new ToolCompiler.Stream(res, 'claude', compiler, session)

      claudeStreamHandler(res, stream, session, saveSession, parser, userData)
    } catch (error) {
      console.error('[Claude Route] Error:', error.message)
      const err = toOpenAIError(error, 'Claude')
      return res.status(err.error.status || 500).json(err)
    }
  })

  return router
}

module.exports = { buildClaudeRouter }
