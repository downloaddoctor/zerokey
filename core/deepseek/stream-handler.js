const { readSSE } = require('../../utils/sse-reader')
const { createSendFinalChunk, createOnError } = require('../../utils/stream-helpers')

/**
 * DeepSeek SSE Stream Handler
 *
 * DeepSeek SSE formats:
 *   data: {"o":"SET","v":"FINISHED"}         → stream complete
 *   data: {"o":"BATCH","v":[...]}            → token usage
 *   data: {"v":{"response":{...}}}           → message delta with metadata
 *   data: {"v":"text"}                       → bare text delta
 */
function streamHandler(res, stream, session, parser, retry) {
  const tokenUsage = {}
  const sendFinalChunk = createSendFinalChunk(res, session, parser, tokenUsage)
  const onError = createOnError(res, parser, 'DeepSeek')
  let cancelled = false

  const onData = (data) => {
    if (cancelled) return

    if (data.type === 'error') {
      console.error('[DeepSeek] Error event:', data.content)
      if (retry) {
        console.log('[DeepSeek] Retrying request...')
        cancelled = true
        try {
          stream.destroy()
        } catch (_) {}
        retry()
          .then((newStream) => {
            streamHandler(res, newStream, session, parser, null)
          })
          .catch((err) => {
            console.error('[DeepSeek] Retry failed:', err.message)
            sendFinalChunk()
          })
      } else {
        sendFinalChunk()
      }
      return
    } else if (data.o === 'SET') {
      if (data.v === 'FINISHED') sendFinalChunk()
    } else if (data.o === 'BATCH') {
      const usageEntry = data.v?.find((e) => e.p === 'accumulated_token_usage')
      const statusEntry = data.v?.find((e) => e.p === 'quasi_status')
      if (usageEntry) {
        tokenUsage.completion_tokens = usageEntry.v
        tokenUsage.total_tokens = usageEntry.v + (tokenUsage.prompt_tokens || 0)
        console.log('[DeepSeek] Token usage:', {
          accumulated: usageEntry.v,
          status: statusEntry?.v ?? null,
        })
      }
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

  readSSE(stream, { onData, onDone: sendFinalChunk, onError })
}

module.exports = { streamHandler }
