const { readSSE } = require('../../utils/sse-reader')
const { createSendFinalChunk, createOnError } = require('../../utils/stream-helpers')

/**
 * @param {object} w - window object from Claude API { utilization, resets_at }
 * @param {'full'|'time'|'date'} resetFormat
 * @returns {{ pct: string, reset: string, util: number }}
 */
function formatWindow(w, resetFormat = 'time') {
  const util = w?.utilization ?? 0
  const used = (util * 100).toFixed(1)
  const pct = used + '%'
  let reset = 'n/a'
  if (w?.resets_at) {
    const d = new Date(w.resets_at * 1000)
    reset =
      resetFormat === 'full'
        ? d.toLocaleString()
        : resetFormat === 'date'
          ? d.toLocaleDateString()
          : d.toLocaleTimeString()
  }
  return { pct, reset, resets_at: w?.resets_at, used, util }
}

/**
 * Claude SSE Stream Handler
 * Claude SSE event types:
 *   data: {"type":"message_start","message":{...}}
 *   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
 *   data: {"type":"message_stop"}
 *   data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
 *
 * @param {object} res
 * @param {ReadableStream} stream
 * @param {object} session
 * @param {object} parser
 */
async function claudeStreamHandler(res, stream, session, parser, cb) {
  const tokenUsage = {}
  let limitReached = null
  const sendFinalChunk = createSendFinalChunk(res, session, parser, tokenUsage)
  const onError = createOnError(res, parser, 'Claude')

  await readSSE(stream, {
    onData: (parsed) => {
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
            const h5 = formatWindow(ml.windows?.['5h'], 'time')
            const d7 = formatWindow(ml.windows?.['7d'], 'full')

            console.warn(
              `[Claude] Limit: ${ml.type} | 5h: ${h5.pct} (resets ${h5.reset}) | 7d: ${d7.pct} (resets ${d7.reset})`,
            )

            const worstWindow = h5.util > d7.util ? h5 : d7
            const CONTEXT_WINDOW = 264_000
            const usedTokens = Math.round(worstWindow.util * CONTEXT_WINDOW)
            tokenUsage.prompt_tokens = usedTokens
            tokenUsage.completion_tokens = 0
            tokenUsage.total_tokens = usedTokens

            if (worstWindow.util >= 0.9) {
              limitReached = worstWindow
            }
          }
          break
        }
        case 'error': {
          const err = parsed.error || {}
          onError({ message: err.message, type: err.type })
          break
        }
      }
    },
    onDone: () => {},
    onError,
  })

  if (limitReached && cb) {
    await cb(limitReached, sendFinalChunk)
    return
  }

  sendFinalChunk()
}

module.exports = { claudeStreamHandler }
