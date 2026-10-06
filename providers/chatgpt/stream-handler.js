'use strict'

const { readSSE } = require('../../utils/sse-reader')

/**
 * ChatGPT SSE Stream Handler
 *
 * Formats handled here:
 *   data: {"type":"input_message"}                                 -> capture parent message id
 *   data: {"o":"add","v":{"message":{...}}}                        -> assistant msg created
 *   data: {"p":"/message/content/parts/0","o":"append","v":"text"} -> text delta
 *   data: {"v":"text"}                                             -> bare delta
 *   data: {"o":"patch","v":[{...},{"status":"finished_successfully"}]} -> batch finish
 *   data: {"type":"message_stream_complete"}                       -> finish
 *   data: [DONE]                                                   -> finish
 *
 * Malformed payloads and handoff tokens are counted and tracked; the handler
 * refuses to close a turn as success when nothing was produced and no
 * explicit completion marker arrived.
 */
async function chatgptStreamHandler(stream, session, parser) {
  let finished = false
  let dataCount = 0
  let malformedPayloads = 0
  let producedOutput = false
  let lastEventType = null
  let sawCompletionMarker = false
  let sawDoneMarker = false
  let resumeToken = null

  const onData = (data) => {
    if (!data) return
    dataCount++
    lastEventType = data.type || data.o || data.p || typeof data.v

    if (typeof data === 'string') {
      if (data === 'v1') return
      // The upstream occasionally sends bare text deltas without a wrapper.
      if (data.length > 0) {
        producedOutput = true
        parser.scan(data)
      }
      return
    }

    if (data.type === 'input_message' && data.input_message?.id) {
      session.parentId = data.input_message.id
      return
    }
    if (data.type === 'message_stream_complete') {
      finished = true
      sawCompletionMarker = true
      if (data.conversation_id) session.id = data.conversation_id
      return
    }
    if (data.type === 'resume_conversation_token') {
      if (typeof data.token === 'string') resumeToken = data.token
      if (data.conversation_id) session.id = data.conversation_id
      return
    }
    if (data.type === 'stream_handoff') {
      // Nothing to do here; the caller resumes via a new request. Record it
      // so the error path can report why the stream closed early.
      lastEventType = 'stream_handoff'
      return
    }
    if (data.o === 'add' && data.v?.message?.id) {
      session.parentId = data.v.message.id
      return
    }
    if (data.p === '/message/content/parts/0' && data.o === 'append') {
      producedOutput = true
      parser.scan(typeof data.v === 'string' ? data.v : '')
      return
    }
    if (typeof data.v === 'string' && !data.o && !data.p) {
      producedOutput = true
      parser.scan(data.v)
      return
    }
    if (data.o === 'patch' && Array.isArray(data.v)) {
      for (const op of data.v) {
        if (op.p === '/message/content/parts/0' && op.o === 'append') {
          producedOutput = true
          parser.scan(typeof op.v === 'string' ? op.v : '')
        }
        if (op.p === '/message/status' && op.o === 'replace' && op.v === 'finished_successfully') {
          finished = true
          sawCompletionMarker = true
        }
      }
    }
  }

  await readSSE(stream, {
    onData,
    onDone: () => {
      sawDoneMarker = true
      // Refuse silent success: a stream that ended with no output and no
      // completion marker is a failure the caller must see.
      if (!producedOutput && !sawCompletionMarker) {
        const error = new Error(
          'ChatGPT stream closed without producing output or a completion marker.',
        )
        error.code = 'upstream_incomplete_stream'
        error.httpStatus = 502
        return parser.onError(error, {
          source: 'stream',
          finished,
          lastEventType,
          dataCount,
          malformedPayloads,
          producedOutput,
          sawCompletionMarker,
          sawDoneMarker,
          resumeToken,
        })
      }
      parser.sendFinalChunk()
    },
    onError: (e) =>
      parser.onError(e, {
        source: 'stream',
        finished,
        lastEventType,
        dataCount,
        malformedPayloads,
        producedOutput,
        sawCompletionMarker,
        sawDoneMarker,
        resumeToken,
      }),
  })
}

module.exports = { chatgptStreamHandler }
