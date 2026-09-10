const { readSSE } = require('../../utils/sse-reader')

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
async function claudeStreamHandler(stream, session, parser, cb) {
  let limitReached = null
  // Claude emits thinking blocks as content_block_start{type:"thinking"} then
  // content_block_delta{delta:{type:"thinking_delta"}}. Mirror Qwen/DeepSeek:
  // open the reasoning channel once, then stream reasoning_content deltas.
  let hasSentReasoningRole = false

  const emitReasoning = (delta) => {
    if (!delta) return
    if (!hasSentReasoningRole) {
      parser.emit({ role: 'assistant', reasoning_content: '' })
      hasSentReasoningRole = true
    }
    parser.emit({ reasoning_content: delta })
  }

  await readSSE(stream, {
    onData: (parsed) => {
      switch (parsed.type) {
        case 'message_start': {
          const msg = parsed.message
          if (msg) session.parentMessageId = msg.uuid
          break
        }
        case 'content_block_start': {
          const block = parsed.content_block || {}
          if (block.type === 'thinking' && block.thinking) {
            emitReasoning(block.thinking)
          }
          break
        }
        case 'content_block_delta': {
          const delta = parsed.delta || {}
          if (delta.type === 'text_delta' && delta.text) {
            parser.scan(delta.text)
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            emitReasoning(delta.thinking)
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
            parser.tokenUsage.prompt_tokens = usedTokens
            parser.tokenUsage.completion_tokens = 0
            parser.tokenUsage.total_tokens = usedTokens

            if (worstWindow.util >= 0.9) {
              limitReached = worstWindow
            }
          }
          break
        }
        case 'error': {
          const err = parsed.error || {}
          parser.onError({ message: err.message, type: err.type })
          break
        }
      }
    },
    onDone: () => {},
    onError: (e) => parser.onError(e),
  })

  if (limitReached && cb) {
    await cb(limitReached)
    return
  }

  parser.sendFinalChunk()
}

module.exports = { claudeStreamHandler }
