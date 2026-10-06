'use strict'

const { readSSE } = require('../../utils/sse-reader')

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
  let finalized = false
  let superseded = false

  const logIssue = (summary, err, extra = {}) => {
    console.error(`[QWEN] ${summary}`, err, {
      chatSessionId: session.id,
      parentMessageId: session.parentId,
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
    session.parentId = id
  }

  const emitChunk = (delta, finishReason = null) => {
    const chunk = {
      id: responseId || session.id || '',
      model: parser.compiler.provider,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      created: Math.floor(Date.now() / 1000),
    }
    parser.writeChunk(chunk)
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
    if (finalized) return
    finalized = true
    finished = true
    parser.sendFinalChunk()
    if (!superseded && onFinished && responseId) onFinished(responseId)
  }

  const BACKSLASH = String.fromCharCode(0x5c)

  const extractSayText = (argsStr) => {
    const m = /"raw"\s*:\s*"/.exec(argsStr)
    if (!m) return null
    let body = argsStr.slice(m.index + m[0].length)
    let trail = 0
    while (trail < body.length && body[body.length - 1 - trail] === BACKSLASH) trail++
    if (trail % 2 === 1) body = body.slice(0, -1)
    try {
      return JSON.parse('"' + body + '"')
    } catch (caughtErr) {
      console.error('JSON.parse() failed:', caughtErr)
      for (let cut = body.length - 1; cut >= 0; cut--) {
        if (body[cut] === BACKSLASH) continue
        try {
          return JSON.parse('"' + body.slice(0, cut + 1) + '"')
        } catch (caughtErr) {
          console.error('JSON.parse() failed:', caughtErr)
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
      const err = new Error('Qwen stream error: ' + reason)
      err.code = code
      err.status = code || 500
      err.statusCode = err.status
      logIssue('provider error — ' + err.message, err, {
        raw: data,
        retryable: !!RETRY_CODES[code] && !!retry,
      })

      if (RETRY_CODES[code] && retry) {
        superseded = true
        parser.emitText('\n\n⚠ Stream error: ' + reason + '\n')
        parser.emitText('Retrying...\n')
        try {
          stream.destroy?.()
        } catch (caughtErr) {
          console.error('stream.destroy?.() failed:', caughtErr)
        }
        retry()
          .then((newStream) => {
            streamHandler(newStream, session, parser, retry, onFinished)
          })
          .catch((retryErr) => {
            logIssue('retry failed — ' + (retryErr?.message || retryErr), retryErr)
            parser.emitText('\n⚠ Retry failed: ' + (retryErr?.message || retryErr) + '\n')
          })
        return
      }

      parser.emitText('\n\n⚠ Stream error: ' + reason + '\n')
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
        const key = phase + ':' + fc.name
        if (key !== lastToolPhase) {
          lastToolPhase = key
          emitReasoning('\n[' + fc.name + '...]\n')
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
        finished = true
      }
    }
  }

  readSSE(stream, {
    onData,
    onDone: () => finish(),
    onError: (e) =>
      parser.onError(e, {
        source: 'stream',
        finished,
        lastEventType,
        dataCount,
        producedOutput,
        responseId,
      }),
  })
}

module.exports = { streamHandler }
