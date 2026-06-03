const { readSSE } = require('../../utils/sse-reader')
const { classifyError } = require('../../utils/errors')

const CLAUDE_FALLBACK_MODEL = 'claude-haiku-4-5-20251001'

/**
 * Claude SSE Stream Handler
 *
 * Claude SSE event types:
 *   data: {"type":"message_start","message":{...}}
 *   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
 *   data: {"type":"message_stop"}
 *   data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
 */
async function claudeStreamHandler(res, stream, session, saveSession, parser, userData = null) {
  let finished = false
  const tokenUsage = {}

  const sendFinalChunk = () => {
    if (finished) return
    finished = true
    parser.flush()
    parser.emit({}, 'stop', tokenUsage)
    res.write('data: [DONE]\n\n')
    res.end()
    session.lastUsed = new Date().toISOString()
    saveSession()
  }

  const onData = (parsed) => {
    switch (parsed.type) {
      case 'message_start': {
        const msg = parsed.message
        if (msg) session.parentMessageId = msg.uuid
        break
      }
      case 'content_block_delta': {
        const delta = parsed.delta || {}
        if (delta.type === 'text_delta' && delta.text) {
          parser.scan(delta.text)
        }
        break
      }
      case 'message_limit': {
        const ml = parsed.message_limit
        if (ml) {
          const w5h = ml.windows?.['5h']
          const w7d = ml.windows?.['7d']
          console.log(
            `[Claude] Limit: ${ml.type} | 5h: ${w5h ? (w5h.utilization * 100).toFixed(1) + '%' : 'n/a'} (resets ${w5h?.resets_at ? new Date(w5h.resets_at * 1000).toLocaleTimeString() : 'n/a'}) | 7d: ${w7d ? (w7d.utilization * 100).toFixed(1) + '%' : 'n/a'} (resets ${w7d?.resets_at ? new Date(w7d.resets_at * 1000).toLocaleTimeString() : 'n/a'})`,
          )

          const windows = [w5h, w7d].filter((window) => window && window.utilization != null)
          const nearLimit = windows.some((window) => window.utilization >= 0.95)
          const resetTs = windows
            .map((window) => (window?.resets_at ? window.resets_at * 1000 : Infinity))
            .reduce((min, ts) => (ts < min ? ts : min), Infinity)

          if (nearLimit && userData && userData.model !== CLAUDE_FALLBACK_MODEL) {
            userData.model = CLAUDE_FALLBACK_MODEL
            if (resetTs < Infinity) {
              userData.modelFallbackExpiresAt = new Date(resetTs).toISOString()
            }
            userData.modelFallbackReason = ml.type
            saveSession()
            console.log(
              `[Claude] Usage near limit; switched stored model to ${CLAUDE_FALLBACK_MODEL}` +
                (userData.modelFallbackExpiresAt
                  ? ` until ${userData.modelFallbackExpiresAt}`
                  : ''),
            )
          }
        }
        break
      }
      case 'error': {
        const err = parsed.error || {}
        const classified = classifyError({ message: err.message, type: err.type }, 'Claude')
        console.error(`[Claude Stream] Error: ${err.type} - ${err.message}`)
        finished = true
        parser.emit({}, 'error', {})
        res.write(
          `data: ${JSON.stringify({ error: { message: classified.message, action: classified.action, category: classified.category } })}\n\n`,
        )
        res.end()
        break
      }
      case 'message_stop': {
        sendFinalChunk()
        break
      }
    }
  }

  await readSSE(stream, {
    onData,
    onDone: sendFinalChunk,
    onError: (err) => {
      const classified = classifyError(err, 'Claude')
      console.error(`[Claude Stream] ${classified.category}: ${err.message}`)
      if (finished) return

      finished = true
      parser.emit({}, 'error', {})
      res.write(
        `data: ${JSON.stringify({ error: { message: classified.message, action: classified.action, category: classified.category } })}\n\n`,
      )
      res.end()
    },
    isDone: () => finished,
  })
}

module.exports = { claudeStreamHandler }
