const { readSSE } = require('../../utils/sse-reader')
const { LogSaver, serializeError } = require('../../utils/log-saver')

const streamLog = new LogSaver({ name: 'qwen-error' })

/**
 * Qwen AI (chat.qwen.ai) SSE Stream Handler
 *
 * Qwen streams SSE events whose `choices[0].delta` carries a `phase`:
 *   - 'think'            → reasoning_content delta (streamed live)
 *   - 'thinking_summary' → reasoning_content delta, from extra.summary_thought.content[]
 *   - 'answer'           → content delta
 *   - null               → content delta (no phase marker)
 *
 * `status === 'finished'` on an answer/null phase ends the stream.
 * `response.created.response_id` is captured for the response id.
 *
 * @param {ReadableStream} stream
 * @param {object} session
 * @param {StreamPipeline} parser
 * @param {Function} [retry] — unused for Qwen; kept for signature parity
 */
function streamHandler(stream, session, parser, _retry) {
  let responseId = ''
  let hasSentReasoningRole = false
  let summaryText = ''
  let finished = false
  let dataCount = 0
  let producedOutput = false
  let lastEventType = null

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

  const onData = (data) => {
    dataCount++
    lastEventType = data['response.created']
      ? 'response.created'
      : data.choices?.[0]?.delta?.phase || 'other'

    if (data.error) {
      finished = true
      const err = new Error(
        `Qwen stream error: ${data.error.message || data.error.type || JSON.stringify(data.error)}`,
      )
      err.status = data.error.code || 500
      err.statusCode = err.status
      logIssue(`provider error — ${err.message}`, {
        error: serializeError(err),
        raw: data,
      })
      throw err
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

    if (phase === 'answer' || phase === null) {
      if (content) {
        producedOutput = true
        parser.scan(content)
      }

      if (status === 'finished') {
        finish()
      }
    }
  }

  readSSE(stream, {
    onData,
    onDone: () => {
      if (!finished) {
        logIssue(
          producedOutput
            ? 'stream closed without finished status (partial output)'
            : 'stream closed without finished status (no output)',
        )
      }
      finish()
    },
    onError: (e) => {
      if (finished) return
      finished = true
      logIssue(`read error — ${e?.message || e}`, { error: serializeError(e) })
      parser.onError(e)
    },
  })
}

module.exports = { streamHandler }
