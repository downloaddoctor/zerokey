const { readSSE } = require('../../utils/sse-reader')

/**
 * Backoff before retrying a Claude request that answered `overloaded_error`.
 * 1 min → 2 min → 4 min (max 3 retries).
 */
const OVERLOAD_RETRY_DELAYS_MS = [60_000, 120_000, 240_000]

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
 * When Claude answers `overloaded_error`, the stream is retried up to 3 times
 * with 1/2/4-minute backoff. `options.refetch` must return a fresh
 * `{ stream }` for the same completion.
 *
 * @param {object} res
 * @param {ReadableStream} stream
 * @param {object} session
 * @param {object} parser
 * @param {object} [options]
 * @param {function} [options.refetch]
 */
async function claudeStreamHandler(stream, session, parser, cb, options = {}) {
  const { refetch } = options
  let limitReached = null
  let overloadAttempts = 0

  const attemptStream = (currentStream) =>
    new Promise((resolveAttempt) => {
      let finished = false
      let dataCount = 0
      let producedOutput = false
      let lastEventType = null
      let overloadRetryPending = false
      let hasSentReasoningRole = false
      // Accumulated thinking-summary text. Claude streams cumulative summaries
      // in `thinking_summary_delta.summary.summary`; we emit only the new tail
      // so the client sees each summary line exactly once.
      let summaryText = ''

      const emitReasoning = (delta) => {
        if (!delta) return
        producedOutput = true
        if (!hasSentReasoningRole) {
          parser.emit({ role: 'assistant', reasoning_content: '' })
          hasSentReasoningRole = true
        }
        parser.emit({ reasoning_content: delta })
      }

      readSSE(currentStream, {
        // Raw upstream SSE lines, verbatim as received (including `event:` and
        // `data:` prefixes) — the exact evidence for tracing a dead/empty stream.
        // onRawLine: (line) => {
        //   console.info(`[Claude] SSE raw: ${line}`)
        // },
        onData: (parsed) => {
          dataCount++
          lastEventType = parsed.type || typeof parsed

          if (parsed.type === 'error') {
            const errType = parsed.error?.type
            if (
              errType === 'overloaded_error' &&
              typeof refetch === 'function' &&
              overloadAttempts < OVERLOAD_RETRY_DELAYS_MS.length &&
              !producedOutput
            ) {
              const delay = OVERLOAD_RETRY_DELAYS_MS[overloadAttempts++]
              overloadRetryPending = true
              console.warn(
                `[Claude] overloaded_error — retrying in ${delay / 1000}s (attempt ${overloadAttempts}/${OVERLOAD_RETRY_DELAYS_MS.length})`,
              )
              try {
                currentStream.destroy?.()
              } catch (caughtErr) {
                console.error('currentStream.destroy?.() failed:', caughtErr)
              }
              setTimeout(async () => {
                try {
                  const { stream: nextStream } = await refetch()
                  await attemptStream(nextStream)
                } catch (err) {
                  parser.onError(err, {
                    source: 'retry',
                    finished,
                    lastEventType,
                    dataCount,
                    producedOutput,
                    overloadAttempts,
                  })
                }
                resolveAttempt()
              }, delay)
              return
            }
            parser.onError(new Error(`Claude stream error: ${parsed.error?.message || errType}`), {
              source: 'stream',
              finished,
              lastEventType,
              dataCount,
              producedOutput,
              hasSentReasoningRole,
              overloadAttempts,
            })
            return
          }

          switch (parsed.type) {
            case 'message_start': {
              const msg = parsed.message
              if (msg) session.parentId = msg.uuid
              break
            }
            case 'content_block_start': {
              const block = parsed.content_block || {}
              if (block.type === 'thinking') {
                // Some streams deliver the initial reasoning text inline.
                if (block.thinking) emitReasoning(block.thinking)
                // Others deliver summaries upfront as an array of strings.
                if (Array.isArray(block.summaries) && block.summaries.length > 0) {
                  const seed = block.summaries.filter((s) => typeof s === 'string').join('\n')
                  if (seed && seed.length > summaryText.length) {
                    emitReasoning(seed.substring(summaryText.length))
                    summaryText = seed
                  }
                }
              }
              break
            }
            case 'content_block_delta': {
              const delta = parsed.delta || {}
              if (delta.type === 'text_delta' && delta.text) {
                producedOutput = true
                parser.scan(delta.text)
              } else if (delta.type === 'thinking_delta' && delta.thinking) {
                emitReasoning(delta.thinking)
              } else if (delta.type === 'thinking_summary_delta') {
                // `summary.summary` is cumulative — emit only the new tail.
                const next = delta.summary?.summary
                if (typeof next === 'string' && next.length > summaryText.length) {
                  emitReasoning(next.substring(summaryText.length))
                  summaryText = next
                }
              }
              break
            }
            case 'message_stop': {
              finished = true
              break
            }
            case 'message_limit': {
              const ml = parsed.message_limit
              if (ml) {
                const h5 = formatWindow(ml.windows?.['5h'], 'time')
                const d7 = formatWindow(ml.windows?.['7d'], 'full')

                console.debug(
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
          }
        },
        onDone: () => {
          if (overloadRetryPending) return
          if (finished) {
            parser.sendFinalChunk()
            resolveAttempt()
            return
          }
          parser.emitText(`\n\n⚠ Claude stream closed before message_stop.\n`)
          parser.sendFinalChunk()
          resolveAttempt()
        },
        onError: (e) => {
          parser.onError(e, {
            source: 'stream',
            finished,
            lastEventType,
            dataCount,
            producedOutput,
            hasSentReasoningRole,
            overloadAttempts,
          })
          resolveAttempt()
        },
      })
    })

  await attemptStream(stream)

  if (limitReached && cb) await cb(limitReached)
}

module.exports = { claudeStreamHandler }
