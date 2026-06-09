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
async function chatgptStreamHandler(res, stream, session, saveSession, parser) {
  const tokenUsage = {}
  const sendFinalChunk = createSendFinalChunk(res, session, saveSession, parser, tokenUsage)
  const onError = createOnError(res, parser, 'ChatGPT')
  let finished = false

  const onData = (data) => {
    if (!data) return

    // input_message → capture parent message id
    if (data.type === 'input_message' && data.input_message?.id) {
      session.parentMessageId = data.input_message.id
      return
    }
    // message_stream_complete → finish
    if (data.type === 'message_stream_complete') {
      session.chatSessionId = data.conversation_id
      sendFinalChunk()
      return
    }
    // resume_conversation_token → save conversation_id
    if (data.type === 'resume_conversation_token' && data.conversation_id) {
      session.chatSessionId = data.conversation_id
      return
    }
    // assistant message created — capture id
    if (data.o === 'add' && data.v?.message?.id) {
      session.parentMessageId = data.v.message.id
      return
    }
    // text delta with p/o → parser.scan
    if (data.p === '/message/content/parts/0' && data.o === 'append') {
      parser.scan(data.v)
      return
    }
    // bare text delta (event: delta lines, no p/o) → parser.scan
    if (typeof data.v === 'string' && !data.o && !data.p) {
      parser.scan(data.v)
      return
    }
    // batch patch → parse array, scan text, finish on status
    if (data.o === 'patch' && Array.isArray(data.v)) {
      for (const op of data.v) {
        if (finished) break
        if (op.p === '/message/content/parts/0' && op.o === 'append') {
          parser.scan(op.v)
        }
        if (op.p === '/message/status' && op.o === 'replace' && op.v === 'finished_successfully') {
          sendFinalChunk()
        }
      }
    }
  }

  await readSSE(stream, {
    onData,
    onDone: sendFinalChunk,
    onError,
    isDone: () => finished,
  })
}

module.exports = { chatgptStreamHandler }
