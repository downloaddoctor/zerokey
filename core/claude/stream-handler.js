const { readSSE } = require('../../utils/sse-reader')

/**
 * Claude SSE Stream Handler
 *
 * Claude SSE event types:
 *   data: {"type":"message_start","message":{...}}
 *   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
 *   data: {"type":"message_stop"}
 */
async function claudeStreamHandler(res, stream, session, saveSession, parser) {
  let finished = false
  const tokenUsage = {}

  const sendFinalChunk = () => {
    if (finished) return
    finished = true
    parser.flush()
    parser.emit({}, 'stop', tokenUsage)
    res.write('data: [DONE]')
    res.end()
    session.lastUsed = new Date().toISOString()
    saveSession()
  }

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
      case 'message_stop': {
        sendFinalChunk()
        break
      }
    }
  }

  await readSSE(stream, {
    onData,
    onDone: sendFinalChunk,
    onError: (err) => {
      console.error('[Claude Stream] Error:', err.message)
      if (finished) return

      finished = true
      parser.emit({}, 'error', {})
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
      res.end()
    },
    isDone: () => finished,
  })
}

module.exports = { claudeStreamHandler }
