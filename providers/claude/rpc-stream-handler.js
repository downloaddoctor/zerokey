'use strict'

/**
 * Incremental emitter for the Connect-RPC (StreamTimeline) transport.
 *
 * connect-rpc.js#sendMessage calls text()/reasoning() per decoded delta as
 * frames arrive; this forwards them to the pipeline immediately (reasoning via
 * the reasoning channel, text via pipeline.scan), mirroring
 * providers/claude/stream-handler.js so the tool loop sees identical shapes.
 * Call finish() once the stream reports done.
 *
 * @param {object} parser StreamPipeline
 * @returns {{text: (t: string) => void, reasoning: (r: string) => void, finish: () => void}}
 */
function createRpcEmitter(parser) {
  let hasSentReasoningRole = false
  return {
    reasoning(delta) {
      if (!delta) return
      if (!hasSentReasoningRole) {
        parser.emit({ role: 'assistant', reasoning_content: '' })
        hasSentReasoningRole = true
      }
      parser.emit({ reasoning_content: delta })
    },
    text(delta) {
      if (delta) parser.scan(delta)
    },
    finish() {
      parser.sendFinalChunk()
    },
  }
}

module.exports = { createRpcEmitter }
