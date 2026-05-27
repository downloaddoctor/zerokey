const { readSSE } = require('../../utils/sse-reader')
const { classifyError } = require('../../utils/errors')

/**
 * DeepSeek SSE Stream Handler
 *
 * DeepSeek SSE formats:
 *   data: {"o":"SET","v":"FINISHED"}         → stream complete
 *   data: {"o":"BATCH","v":[...]}            → token usage
 *   data: {"v":{"response":{...}}}           → message delta with metadata
 *   data: {"v":"text"}                       → bare text delta
 */
function streamHandler(res, stream, session, parser, saveSession) {
  let finished = false
  const tokenUsage = {}

  const sendFinalChunk = () => {
    if (finished) return
    finished = true
    parser.flush()
    parser.emit({}, 'stop', tokenUsage)
    res.write('data: [DONE]\n\n')
    res.end()
    saveSession()
  }

  const onData = (data) => {
    if (data.o === 'SET') {
      if (data.v === 'FINISHED') {
        sendFinalChunk()
      }
    } else if (data.o === 'BATCH') {
      tokenUsage.completion_tokens = data.v[0].v
      tokenUsage.total_tokens = tokenUsage.completion_tokens + (tokenUsage.prompt_tokens || 0)
    } else {
      const response = data.v?.response
      if (response) {
        session.parentMessageId = response.message_id
        session.lastUsed = new Date().toISOString()
        tokenUsage.prompt_tokens = response.accumulated_token_usage
        parser.scan(response.fragments[0]?.content || '')
      } else if (typeof data.v === 'string') {
        parser.scan(data.v)
      }
    }
  }

  readSSE(stream, {
    onData,
    onDone: sendFinalChunk,
    onError: (err) => {
      const classified = classifyError(err, 'DeepSeek')
      console.error(`[DeepSeek Stream] ${classified.category}: ${err.message}`)
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ error: { message: classified.message, action: classified.action, category: classified.category } })}\n\n`,
        )
        res.end()
      }
    },
    isDone: () => finished,
  })
}

module.exports = { streamHandler }
