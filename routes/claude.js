const express = require('express')
const { ClaudeAPI } = require('../core/claude/api')
const { claudeStreamHandler } = require('../core/claude/stream-handler')
const { toOpenAIError } = require('../utils/errors')
const ToolCompiler = require('../lib/engine')
const { setClaudeInstructions } = require('../core/claude/set-instructions')
const { extractFiles, uploadExtractedFiles } = require('../utils/extract-files')

const claudeApi = new ClaudeAPI()
const { acquireSlot } = require('../utils/rate-limiter')

async function buildClaudeRouter(parsedFetch, session, userData = null) {
  console.debug('[Claude] Initializing from parsed capture JSON')
  await claudeApi.initializeFromJSON(parsedFetch)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [] } = req.body
    const toolCalling = session.toolCalling ?? true
    const model = session.model

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
      await setClaudeInstructions(claudeApi, userData, dynamicGrammar, toolCalling)
    }

    // Extract and upload files from messages
    const files = extractFiles(messages)
    const fileIds = await uploadExtractedFiles(files, (f) => claudeApi.uploadFile(f), 'Claude')

    await acquireSlot('Claude')

    try {
      const { stream, chatSessionId } = await claudeApi.chatCompletion(
        prompt,
        session.chatSessionId,
        session.parentMessageId,
        model,
        [],
        fileIds,
      )

      if (chatSessionId && !session.chatSessionId) {
        session.chatSessionId = chatSessionId
      }

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Access-Control-Allow-Origin', '*')

      const parser = new ToolCompiler.Stream(res, 'claude', compiler, session)

      await claudeStreamHandler(res, stream, session, parser, async (limitReached) => {
        if (limitReached?.resets_at) {
          console.warn(`[Claude] ⚠ Usage at ${limitReached.pct} — requesting summary`)

          userData.waitUntil = limitReached.resets_at * 1000
          userData.waitReason = 'Claude rate limit'

          const resetTime = new Date(userData.waitUntil).toLocaleTimeString()
          const mins = Math.max(1, Math.ceil((userData.waitUntil - Date.now()) / 60000))

          try {
            const summaryPrompt = `Please write a concise but complete summary of this entire conversation — so it can be pasted into a fresh session to resume work seamlessly.`
            const { stream: summaryStream } = await claudeApi.chatCompletion(
              summaryPrompt,
              session.chatSessionId,
              session.parentMessageId,
              model,
              [],
            )

            parser.scan('```text\n')
            await claudeStreamHandler(
              res,
              summaryStream,
              session,
              parser,
              (limitReached, sendFinalChunk) => {
                parser.scan('\n```')
                sendLimitMessage(parser, resetTime, mins)
                sendFinalChunk()
              },
            )
          } catch (summaryErr) {
            console.error(`[Claude] Summary failed: ${summaryErr.message}`)
          }

          setImmediate(() => process.exit(0))
          return
        }
      })
    } catch (error) {
      if (res.headersSent) return
      console.error(`[Claude] Route error: ${error.message}`)

      try {
        const raw = JSON.parse(error.message)
        const payload = raw?.error?.message ? JSON.parse(raw.error.message) : null
        const limit = payload?.resolved?.limit
        const reset = limit?.resets_at || payload?.windows?.['5h']?.resets_at || payload?.resetsAt

        if (reset) {
          userData.waitUntil = typeof reset === 'number' ? reset * 1000 : new Date(reset).getTime()
          userData.waitReason = limit?.title || payload?.notice?.title || 'Claude rate limit'
        }

        if (payload?.resolved?.status === 'exceeded') {
          const resetMs = userData.waitUntil || payload?.resolved?.limit?.resets_at * 1000
          const mins = Math.max(1, Math.ceil((resetMs - Date.now()) / 60000))
          const resetTime = new Date(resetMs).toLocaleTimeString()

          res.setHeader('Content-Type', 'text/event-stream')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
          res.setHeader('Access-Control-Allow-Origin', '*')
          const parser = new ToolCompiler.Stream(res, 'claude', compiler, session)
          sendLimitMessage(res, parser, resetTime, mins)
          parser.flush()
          parser.emit({}, 'stop', {})

          res.write('data: [DONE]\n\n')
          res.end()

          setImmediate(() => process.exit(0))
          return
        }
      } catch {}

      const err = toOpenAIError(error, 'Claude')
      return res.status(err.error.status || 500).json(err)
    }
  })

  return router
}

function sendLimitMessage(parser, resetTime, mins) {
  parser.scan(
    `⟦ask¦question=This Claude session has reached its usage limit. It resets at ${resetTime} (~${mins} min). What would you like to do?¦option=Switch to another Claude user¦default=true¦option=Switch to another provider⟧`,
  )
}

module.exports = { buildClaudeRouter }
