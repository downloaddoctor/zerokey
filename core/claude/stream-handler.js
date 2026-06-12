const { readSSE } = require('../../utils/sse-reader')
const { createSendFinalChunk, createOnError } = require('../../utils/stream-helpers')

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
 * @param {function} saveSession
 * @param {object} parser
 * @param {function|null} onNearLimit - async (limitResetTs: number) => void, called once when utilization >= 90%
 */
async function claudeStreamHandler(res, stream, session, parser, onNearLimit = null) {
  const tokenUsage = {}
  const sendFinalChunk = createSendFinalChunk(res, session, parser, tokenUsage)
  const onError = createOnError(res, parser, 'Claude')

  let nearLimit = false
  let limitResetTs = Infinity

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
            const w5h = ml.windows?.['5h']
            const w7d = ml.windows?.['7d']
            console.log(
              `[Claude] Limit: ${ml.type} | 5h: ${w5h ? (w5h.utilization * 100).toFixed(1) + '%' : 'n/a'} (resets ${w5h?.resets_at ? new Date(w5h.resets_at * 1000).toLocaleTimeString() : 'n/a'}) | 7d: ${w7d ? (w7d.utilization * 100).toFixed(1) + '%' : 'n/a'} (resets ${w7d?.resets_at ? new Date(w7d.resets_at * 1000).toLocaleDateString() : 'n/a'})`,
            )

            const windows = [w5h, w7d].filter((w) => w && w.utilization != null)
            const utilization = windows.reduce((max, w) => Math.max(max, w.utilization), 0)
            const resetTs = windows
              .map((w) => (w?.resets_at ? w.resets_at * 1000 : Infinity))
              .reduce((min, ts) => (ts < min ? ts : min), Infinity)

            if (utilization >= 0.95) {
              nearLimit = true
              limitResetTs = resetTs

              if (onNearLimit)
                console.log(
                  `[Claude] ⚠ Usage at ${(utilization * 100).toFixed(1)}% — will auto-summarize after stream`,
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
      }
    },
    onDone: () => {},
    onError,
  })

  if (nearLimit && onNearLimit) {
    await onNearLimit(limitResetTs)
    return // onNearLimit calls its own claudeStreamHandler which calls sendFinalChunk
  }

  sendFinalChunk()
}

module.exports = { claudeStreamHandler }
