'use strict'

const { readSSE } = require('../../utils/sse-reader')

/**
 * Inception SSE (AI-SDK UI message stream) → pipeline.
 * Frames: reasoning-start/delta/end, text-start/delta/end, error, then [DONE].
 * Resolves with the full assistant text once the stream has ended.
 */
async function streamHandler(stream, session, parser) {
  let reply = ''
  let hasSentReasoningRole = false
  let finalized = false
  let dataCount = 0
  let lastEventType = null
  let producedOutput = false

  const emitChunk = (delta) => {
    parser.writeChunk({
      id: session.id || '',
      model: parser.compiler.provider,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: null }],
      created: Math.floor(Date.now() / 1000),
    })
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
    parser.sendFinalChunk()
  }

  const onData = (data) => {
    dataCount++
    lastEventType = data.type
    if (data.type === 'reasoning-delta') {
      emitReasoning(data.delta)
      return
    }
    if (data.type === 'text-delta' && typeof data.delta === 'string') {
      producedOutput = true
      reply += data.delta
      parser.scan(data.delta)
      return
    }
    if (data.type === 'error') {
      const reason = data.errorText || data.message || 'unknown error'
      console.error('[INCEPTION] provider error — ' + reason, new Error(reason), { raw: data })
      parser.emitText('\n\n⚠ Stream error: ' + reason + '\n')
    }
  }

  await readSSE(stream, {
    onData,
    onDone: finish,
    onError: (e) =>
      parser.onError(e, {
        source: 'stream',
        finished: finalized,
        lastEventType,
        dataCount,
        producedOutput,
      }),
  })
  return reply
}

module.exports = { streamHandler }
