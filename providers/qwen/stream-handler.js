const { readSSE } = require('../../utils/sse-reader')
const { LogSaver, serializeError } = require('../../utils/log-saver')

const streamLog = new LogSaver({ name: 'qwen-error' })
const streamDebugLog = new LogSaver({ name: 'qwen-stream-debug', maxSize: 5 * 1024 * 1024 })

const RETRY_CODES = {
  quota_limit: true,
}

function streamHandler(stream, session, parser, retry, onFinished) {
  let responseId = ''
  let hasSentReasoningRole = false
  let summaryText = ''
  let finished = false
  let dataCount = 0
  let producedOutput = false
  let lastEventType = null
  let sayArgsEmitted = ''
  let lastToolPhase = null
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
    if (onFinished && responseId) onFinished(responseId)
  }

  const extractSayText = (argsStr) => {
    const m = /"raw"\s*:\s*"/.exec(argsStr)
    if (!m) return null
    let body = argsStr.slice(m.index + m[0].length)
    let trail = 0
    while (trail < body.length && body[body.length - 1 - trail] === '\\') trail++
    if (trail % 2 === 1) body = body.slice(0, -1)
    try {
      return JSON.parse(`"${body}"`)
    } catch {
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
      if (delta.role === 'function') return

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
              // retry() itself throws for hard failures (e.g. RateLimited —
              // api.js now converts non-SSE 200 responses into a thrown
              // error), so surface that via the normal error path instead
              // of a generic retry-failed message.
              logIssue(`retry failed — ${retryErr?.message || retryErr}`, {
                error: serializeError(retryErr),
              })
              parser.onError(retryErr)
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
