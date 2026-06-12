const { readSSE } = require('../../utils/sse-reader')
const { createSendFinalChunk, createOnError } = require('../../utils/stream-helpers')

/**
 * ChatGPT SSE Stream Handler
 *
 * ChatGPT SSE formats:
 *   data: {"type":"input_message"}                                → capture parent message id
 *   data: {"o":"add","v":{"message":{...}}}                      → assistant msg created
 *   data: {"p":"/message/content/parts/0","o":"append","v":"text"} → text delta
 *   data: {"v":"text"}                                            → bare delta
 *   data: {"o":"patch","v":[{...},{"status":"finished_successfully"}]} → batch finish
 *   data: {"type":"message_stream_complete"}                      → finish
 *   data: [DONE]                                                  → finish
 */
async function chatgptStreamHandler(res, stream, session, parser) {
  const tokenUsage = {}
  const sendFinalChunk = createSendFinalChunk(res, session, parser, tokenUsage)
  const onError = createOnError(res, parser, 'ChatGPT')

  const onData = (data) => {
    if (!data) return

    if (data.type === 'input_message' && data.input_message?.id) {
      session.parentMessageId = data.input_message.id
      return
    }
    if (data.type === 'message_stream_complete') {
      session.chatSessionId = data.conversation_id
      sendFinalChunk()
      return
    }
    if (data.type === 'resume_conversation_token' && data.conversation_id) {
      session.chatSessionId = data.conversation_id
      return
    }
    if (data.o === 'add' && data.v?.message?.id) {
      session.parentMessageId = data.v.message.id
      return
    }
    if (data.p === '/message/content/parts/0' && data.o === 'append') {
      parser.scan(data.v)
      return
    }
    if (typeof data.v === 'string' && !data.o && !data.p) {
      parser.scan(data.v)
      return
    }
    if (data.o === 'patch' && Array.isArray(data.v)) {
      for (const op of data.v) {
        if (op.p === '/message/content/parts/0' && op.o === 'append') parser.scan(op.v)
        if (op.p === '/message/status' && op.o === 'replace' && op.v === 'finished_successfully')
          sendFinalChunk()
      }
    }
  }

  await readSSE(stream, { onData, onDone: sendFinalChunk, onError })
}

module.exports = { chatgptStreamHandler }
