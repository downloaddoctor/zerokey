const { readSSE } = require('../../utils/sse-reader')
const { createSendFinalChunk, createOnError } = require('../../utils/stream-helpers')

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
  const tokenUsage = {}
  const sendFinalChunk = createSendFinalChunk(res, session, saveSession, parser, tokenUsage)
  const onError = createOnError(res, parser, 'Claude')

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
        onError({ message: err.message, type: err.type })
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
    onError,
    isDone: () => false,
  })
}

module.exports = { claudeStreamHandler }
