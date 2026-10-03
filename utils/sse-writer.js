'use strict'

/**
 * SSE writer with backpressure.
 *
 * `res.write()` returns false when the kernel-side socket buffer is full. On
 * a long-running stream (a Claude generation, a multi-turn tool loop) writing
 * unconditionally past that point grows the Node stream buffer without bound.
 * Every frame therefore goes through `write()` here, which awaits `drain` (or
 * client close) before returning when the socket says "slow down".
 *
 * `finish()` and `fail()` are idempotent. A second call is a no-op, not an
 * error: providers call them from several code paths and the stream handlers
 * emit their own `done` events.
 */

function newId() {
  return (
    'chatcmpl-' + Math.abs(Date.now() % 0xffffffff).toString(16) + '-' + process.pid.toString(16)
  )
}

/**
 * Fills the gap between two assistant messages to exactly two newlines.
 * Pure function so it can be tested without a socket.
 */
function joinMessages(soFar, next) {
  if (soFar === '') return next
  const trailing = /\n*$/.exec(soFar)[0].length
  const leading = /^\n*/.exec(next)[0].length
  const missing = Math.max(0, 2 - trailing - leading)
  return soFar + '\n'.repeat(missing) + next
}

function createWriter(res, options = {}) {
  const id = options.id || newId()
  const model = options.model || 'unknown'
  const created = Math.floor(Date.now() / 1000)

  let opened = false
  let finished = false
  let sentRole = false

  const alive = () => !res.destroyed && !res.writableEnded

  function open() {
    if (opened || !alive()) return
    opened = true
    // setSSEHeaders was already called by the route middleware.
    res.writeHead(200)
  }

  function waitForDrain() {
    if (!alive()) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        res.removeListener('drain', done)
        res.removeListener('close', done)
        resolve()
      }
      res.once('drain', done)
      res.once('close', done)
    })
  }

  async function write(raw) {
    open()
    if (!alive()) return
    if (res.write(raw) === false && alive()) await waitForDrain()
  }

  function send(payload) {
    return write('data: ' + JSON.stringify(payload) + '\n\n')
  }

  function frame(delta, finishReason) {
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason === undefined ? null : finishReason,
        },
      ],
    }
  }

  // Every frame runs through one promise chain, so the wire order always
  // equals the call order. Without this, the async methods below are invoked
  // without await: finish() flips `finished` before a pending toolCalls() has
  // run, so the tool call is dropped and the client sees finish_reason first.
  // `finished` is therefore set *inside* the queued finish task, not before.
  let chain = Promise.resolve()
  const enqueue = (task) => {
    chain = chain.then(task, task)
    return chain
  }

  return {
    id,
    open,

    reasoning(value) {
      return enqueue(async () => {
        if (finished || value === '') return
        const delta = { reasoning_content: value }
        if (!sentRole) {
          sentRole = true
          delta.role = 'assistant'
        }
        await send(frame(delta))
      })
    },

    text(value) {
      return enqueue(async () => {
        if (finished || value === '') return
        if (!sentRole) {
          sentRole = true
          await send(frame({ role: 'assistant', content: '' }))
        }
        await send(frame({ content: value }))
      })
    },

    toolCalls(calls) {
      return enqueue(async () => {
        if (finished || !Array.isArray(calls) || calls.length === 0) return
        if (!sentRole) {
          sentRole = true
          await send(frame({ role: 'assistant', content: '' }))
        }
        await send(
          frame({
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: call.type,
              function: call.function,
            })),
          }),
        )
      })
    },

    finish(reason, usage, includeUsage) {
      return enqueue(async () => {
        if (finished) return
        finished = true
        if (!alive()) return
        if (!sentRole) await send(frame({ role: 'assistant', content: '' }))
        await send(frame({}, reason || 'stop'))
        if (!alive()) return
        if (includeUsage && usage) {
          await send({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage,
          })
        }
        if (!alive()) return
        await write('data: [DONE]\n\n')
        if (alive()) res.end()
      })
    },

    fail(message, code) {
      return enqueue(async () => {
        if (finished) return
        finished = true
        open()
        if (!alive()) return
        const type = typeof code === 'string' && code !== '' ? code : 'upstream_error'
        await write('data: ' + JSON.stringify({ error: { message, type, code: type } }) + '\n\n')
        await write('data: [DONE]\n\n')
        if (alive()) res.end()
      })
    },

    isFinished: () => finished,
    headersSent: () => opened,
  }
}

module.exports = { createWriter, joinMessages, newId }
