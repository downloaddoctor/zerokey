const { readSSE } = require('../../utils/sse-reader')
const { LogSaver, serializeError } = require('../../utils/log-saver')

const streamLog = new LogSaver({ name: 'qwen-error' })
// Full raw-frame debug log — every SSE frame as it arrives, plus the reason
// the stream ended. Rotates at 5MB since raw frames are verbose.
const streamDebugLog = new LogSaver({ name: 'qwen-stream-debug', maxSize: 5 * 1024 * 1024 })

// Error codes that indicate a transient, provider-side condition worth
// retrying automatically (mirrors DeepSeek's RETRY_REASONS pattern).
const RETRY_CODES = {
  quota_limit: true,
}

/**
 * Qwen AI (chat.qwen.ai) SSE Stream Handler
 *
 * Qwen streams SSE events whose `choices[0].delta` carries a `phase`:
 *   - 'think'            → reasoning_content delta (streamed live)
 *   - 'thinking_summary' → reasoning_content delta, from extra.summary_thought.content[]
 *   - 'web_search' / 'web_extractor' / etc. → internal tool calls; emitted
 *                          once as a `[toolName...]` reasoning_content status
 *                          line so the client doesn't see dead air during
 *                          tool rounds, then otherwise ignored
 *   - 'answer'           → visible content, delivered one of two ways:
 *       (a) plain `delta.content` deltas (older/simple turns), or
 *       (b) a `say` function_call whose `arguments` is a growing JSON
 *           string like `{"raw":"partial text..."}` — the real content must
 *           be incrementally extracted+decoded from that string since it is
 *           not valid JSON until the call completes.
 *   - null               → content delta (no phase marker)
 *
 * `status === 'finished'` on an answer/null phase ends the stream.
 * `response.created.response_id` is captured for the response id.
 *
 * @param {ReadableStream} stream
 * @param {object} session
 * @param {StreamPipeline} parser
 * @param {Function} [retry] — re-issues chatCompletion on a retryable inline
 *   provider error (see RETRY_CODES); omit to disable auto-retry.
 */
function streamHandler(stream, session, parser, retry) {
  let responseId = ''
  let hasSentReasoningRole = false
  let summaryText = ''
  let finished = false
  let dataCount = 0
  let producedOutput = false
  let lastEventType = null
  // Tracks raw (still-JSON-escaped) argument text already emitted for the
  // current function_call, so we can diff+decode only the new portion.
  let sayArgsEmitted = ''
  // Tracks the last non-answer tool phase we emitted a status line for, so
  // we emit one status per tool call instead of once per SSE frame.
  let lastToolPhase = null
  // Guards the zero-data-frame stream close case so we only auto-retry once.
  let didRetry = false

  const logIssue = (reason, extra = {}) => {
    streamLog.log({
      ts: new Date().toISOString(),
      reason,
      chatSessionId: session.chatSessionId,
      parentMessageId: session.parentMessageId,
      lastEventType,
      dataCount,
      producedOutput,
      finished,
      ...extra,
    })
  }

  // The assistant response_id returned by Qwen is the parent for the next
  // turn. Persist it into session.parentMessageId so the next chatCompletion
  // call sends it as parentId/parent_id (matches live capture behavior).
  const adoptResponseId = (id) => {
    if (!id) return
    responseId = id
    session.parentMessageId = id
  }

  const emitChunk = (delta, finishReason = null) => {
    const chunk = {
      id: responseId || session.chatSessionId || '',
      model: parser.compiler.provider,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      created: Math.floor(Date.now() / 1000),
    }
    parser.res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }

  const emitReasoning = (delta) => {
    if (!delta) return
    producedOutput = true
    if (!hasSentReasoningRole) {
      emitChunk({ role: 'assistant', reasoning_content: '' })
      hasSentReasoningRole = true
    }
    emitChunk({ reasoning_content: delta })
  }

  const finish = () => {
    if (finished) return
    finished = true
    parser.sendFinalChunk()
  }

  // Qwen's newer builds stream the visible answer as a `say` function_call
  // whose `arguments` is a growing, *not yet valid* JSON string, e.g.:
  //   {"raw": "Based on the recent commit
  //   {"raw": "Based on the recent commit (311d
  // We can't JSON.parse a half-open string, so we extract the longest safe
  // prefix of the `"raw":"..."` value, unescape it, and diff against what
  // has already been emitted.
  const extractSayText = (argsStr) => {
    const m = /"raw"\s*:\s*"/.exec(argsStr)
    if (!m) return null
    let body = argsStr.slice(m.index + m[0].length)
    // Trim a dangling unescaped backslash (mid-escape-sequence) so we don't
    // misdecode a partial \u escape or similar on the next chunk.
    let trail = 0
    while (trail < body.length && body[body.length - 1 - trail] === '\\') trail++
    if (trail % 2 === 1) body = body.slice(0, -1)
    try {
      return JSON.parse(`"${body}"`)
    } catch {
      // Body may end mid-escape (e.g. "...\u12"); fall back to the longest
      // JSON-parseable prefix by trimming from the end until it parses.
      for (let cut = body.length - 1; cut >= 0; cut--) {
        if (body[cut] === '\\') continue
        try {
          return JSON.parse(`"${body.slice(0, cut + 1)}"`)
        } catch {
          continue
        }
      }
      return ''
    }
  }

  const onData = (data) => {
    dataCount++
    lastEventType = data['response.created']
      ? 'response.created'
      : data.choices?.[0]?.delta?.phase || 'other'

    if (data.error) {
      finished = true
      const code = data.error.code
      const reason =
        data.error.message ||
        data.error.details ||
        data.error.type ||
        code ||
        JSON.stringify(data.error)
      const err = new Error(`Qwen stream error: ${reason}`)
      err.code = code
      err.status = code || 500
      err.statusCode = err.status
      logIssue(`provider error — ${err.message}`, {
        error: serializeError(err),
        raw: data,
        retryable: !!RETRY_CODES[code] && !!retry,
      })

      if (RETRY_CODES[code] && retry) {
        parser.emitText(`\n\n⚠ Stream error: ${reason}\n`)
        parser.emitText(`Retrying...\n`)
        try {
          stream.destroy?.()
        } catch {}
        retry()
          .then((newStream) => {
            streamHandler(newStream, session, parser, retry)
          })
          .catch((retryErr) => {
            logIssue(`retry failed — ${retryErr?.message || retryErr}`, {
              error: serializeError(retryErr),
            })
            parser.emitText(`\n⚠ Retry failed: ${retryErr?.message || retryErr}\n`)
            parser.sendFinalChunk()
          })
        return
      }

      parser.emitText(`\n\n⚠ Stream error: ${reason}\n`)
      parser.sendFinalChunk()
      return
    }

    const createdId = data['response.created']?.response_id
    if (createdId) adoptResponseId(createdId)
    if (data.response_id && !responseId) adoptResponseId(data.response_id)

    const choice = data.choices?.[0]
    if (!choice) return

    const delta = choice.delta || {}
    const phase = delta.phase
    const status = delta.status
    const content = delta.content || ''

    if (phase === 'think') {
      if (status !== 'finished' && content) emitReasoning(content)
      return
    }

    if (phase === 'thinking_summary') {
      const summaryArr = delta.extra?.summary_thought?.content
      if (Array.isArray(summaryArr)) {
        const newSummary = summaryArr.join('\n')
        if (newSummary && newSummary.length > summaryText.length) {
          const diff = newSummary.substring(summaryText.length)
          emitReasoning(diff)
          summaryText = newSummary
        }
      }
      return
    }

    if (phase && phase !== 'answer' && phase !== 'think' && phase !== 'thinking_summary') {
      // Internal tool phases (web_search, web_extractor, etc.). Qwen can
      // spend many seconds here with zero 'answer'/'think' output, which
      // makes the stream look stalled to the client even though frames are
      // arriving. Surface tool activity as reasoning_content so something
      // visibly streams during these gaps, emitted once per call rather
      // than once per SSE frame.
      if (delta.role === 'function' && status === 'finished') {
        lastToolPhase = null
        return
      }

      const fc = delta.function_call
      if (fc && fc.name && status === 'typing' && !delta.role) {
        const key = `${phase}:${fc.name}`
        if (key !== lastToolPhase) {
          lastToolPhase = key
          emitReasoning(`\n[${fc.name}...]\n`)
        }
      }
      return
    }

    if (phase === 'answer' || phase === null) {
      // Qwen emits role:"function" frames for its own internal tool-result
      // messages ("Tool X does not exists.") and marks them status:"finished".
      // A single stream contains MULTIPLE such answer rounds — a thinking
      // round, a function round, then the real assistant answer. Treating the
      // first status:"finished" as the end truncates the reply after the first
      // round. Only assistant frames carry the real output; skip function ones.
      if (delta.role === 'function') return

      // Newer Qwen builds stream the visible answer wrapped in a `say`
      // function_call instead of plain `delta.content` — extract and diff it.
      const fc = delta.function_call
      if (fc && fc.name === 'say' && typeof fc.arguments === 'string') {
        const decoded = extractSayText(fc.arguments)
        if (decoded !== null && decoded.length > sayArgsEmitted.length) {
          const diff = decoded.slice(sayArgsEmitted.length)
          sayArgsEmitted = decoded
          if (diff) {
            producedOutput = true
            parser.scan(diff)
          }
        }
      } else if (fc && fc.name && fc.name !== 'say') {
        // A different tool call (e.g. web_search/web_extractor) is starting —
        // reset so a subsequent `say` call starts its diff from empty.
        sayArgsEmitted = ''
      }

      if (content) {
        producedOutput = true
        parser.scan(content)
      }

      if (status === 'finished') {
        streamDebugLog.log({
          ts: new Date().toISOString(),
          chatSessionId: session.chatSessionId,
          dataCount,
          stopReason: 'finished status received (normal completion)',
        })
        finish()
      }
    }
  }

  readSSE(stream, {
    onData,
    onDone: () => {
      if (!finished) {
        const noOutput = !producedOutput
        const stopReason = noOutput
          ? 'stream closed without finished status (no output)'
          : 'stream closed without finished status (partial output)'
        logIssue(stopReason)
        streamDebugLog.log({
          ts: new Date().toISOString(),
          chatSessionId: session.chatSessionId,
          dataCount,
          stopReason,
        })

        // A stream that closes with zero data frames at all (dataCount===0)
        // is upstream flakiness, not a parse/logic issue — retry once rather
        // than silently emitting [DONE] with nothing shown to the user.
        if (noOutput && dataCount === 0 && retry && !didRetry) {
          didRetry = true
          finished = true
          parser.emitText(`\n\n⚠ Qwen stream closed with no data. Retrying...\n`)
          retry()
            .then((newStream) => {
              finished = false
              streamHandler(newStream, session, parser, retry)
            })
            .catch((retryErr) => {
              logIssue(`retry failed — ${retryErr?.message || retryErr}`, {
                error: serializeError(retryErr),
              })
              parser.emitText(`\n⚠ Retry failed: ${retryErr?.message || retryErr}\n`)
              parser.sendFinalChunk()
            })
          return
        }

        if (noOutput) {
          parser.emitText(`\n\n⚠ Qwen stream closed with no output.\n`)
        }
      }
      finish()
    },
    onError: (e) => {
      if (finished) return
      finished = true
      logIssue(`read error — ${e?.message || e}`, { error: serializeError(e) })
      streamDebugLog.log({
        ts: new Date().toISOString(),
        chatSessionId: session.chatSessionId,
        dataCount,
        stopReason: `read error — ${e?.message || e}`,
      })
      parser.onError(e)
    },
  })
}

module.exports = { streamHandler }
