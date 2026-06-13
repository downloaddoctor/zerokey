const express = require('express')
const { ClaudeAPI } = require('../core/claude/api')
const { claudeStreamHandler } = require('../core/claude/stream-handler')
const { toOpenAIError } = require('../utils/errors')
const ToolCompiler = require('../lib/engine')
const { setClaudeInstructions } = require('../core/claude/set-instructions')

const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-6'

const claudeApi = new ClaudeAPI()
const { acquireSlot } = require('../utils/rate-limiter')

const SUMMARY_PROMPT =
  'SYSTEM: Please produce a structured summary of everything discussed so far — ' +
  'so the next session can continue seamlessly. Begin with "## Session Summary" and be thorough.'

async function buildClaudeRouter(parsedFetch, session, userData = null, onSwitch = null) {
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

    const compiler = new ToolCompiler(req.ide, 'claude')
    const isNewSession = session.parentMessageId == null

    const { dynamicGrammar } = compiler.syncDynamicTools(req.body.tools || [], session)

    let prompt = compiler.formatPrompt(messages, isNewSession)

    // On first request of a switched-in session, prepend summary directly into prompt
    if (isNewSession && session.pendingSummary) {
      const summary = session.pendingSummary
      delete session.pendingSummary
      console.log('[Claude] 📋 Injecting pending summary into first prompt')
      prompt = `SYSTEM: Previous session summary (use as context):\n\n${summary}\n\n---\n\n${prompt}`
    }

    if (isNewSession) {
      await setClaudeInstructions(claudeApi, userData, dynamicGrammar)
    }

    await acquireSlot('Claude')

    try {
      const { stream, chatSessionId } = await claudeApi.chatCompletion(
        prompt,
        session.chatSessionId,
        session.parentMessageId,
        CLAUDE_DEFAULT_MODEL,
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

      const onNearLimit = async (limitResetTs) => {
        console.log('[Claude] 🔄 Firing inline summary request...')
        try {
          // Set waitUntil BEFORE res.end() fires so autoSwitchMiddleware sees it
          if (userData && limitResetTs < Infinity) {
            userData.waitUntil = limitResetTs
            userData.waitReason = 'rate_limit_error'
            console.log(
              `[Claude] ⏳ waitUntil set to ${new Date(limitResetTs).toLocaleTimeString()}`,
            )
          }

          parser.scan('\n\n---\n\n**[Auto-Summary for next session]**\n\n')

          // Collect summary text while also streaming it
          let summaryText = ''
          const origScan = parser.scan.bind(parser)
          parser.scan = (text) => {
            summaryText += text
            origScan(text)
          }

          const { stream: summaryStream } = await claudeApi.chatCompletion(
            SUMMARY_PROMPT,
            session.chatSessionId,
            session.parentMessageId,
            CLAUDE_DEFAULT_MODEL,
            [],
          )

          await claudeStreamHandler(res, summaryStream, session, parser, null)

          // Restore original scan
          parser.scan = origScan

          // Store summary for next session
          if (summaryText && userData) {
            userData.lastSummary = summaryText.trim()
            console.log(
              `[Claude] ✅ Summary captured (${userData.lastSummary.length} chars) and streamed inline`,
            )
          }

          if (onSwitch) onSwitch()
        } catch (err) {
          console.error('[Claude] Summary call failed:', err.message)
        }
      }

      await claudeStreamHandler(res, stream, session, parser, onNearLimit)
    } catch (error) {
      if (res.headersSent) return
      console.error('[Claude Route] Error:', error.message)

      try {
        const errorObj = JSON.parse(error.message).error
        if (errorObj.type === 'rate_limit_error') {
          const hourLimit = JSON.parse(errorObj.message).windows['5h']
          userData.waitUntil = hourLimit.resets_at * 1000
          userData.waitReason = 'rate_limit_error'
        }
      } catch (parseErr) {}

      const err = toOpenAIError(error, 'Claude')
      return res.status(err.error.status || 500).json(err)
    }
  })

  return router
}

module.exports = { buildClaudeRouter }
