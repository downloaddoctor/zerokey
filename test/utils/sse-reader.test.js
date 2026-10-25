'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Readable } = require('node:stream')
const { ReadableStream } = require('node:stream/web')
const { readSSE } = require('../../utils/sse-reader')

function run(chunks, { web = false } = {}) {
  const events = { data: [], done: 0, error: null }
  const stream = web
    ? new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(Buffer.from(chunk))
          controller.close()
        },
      })
    : Readable.from(chunks.map((chunk) => Buffer.from(chunk)))
  return readSSE(stream, {
    onData: (parsed) => events.data.push(parsed),
    onDone: () => {
      events.done += 1
    },
    onError: (err) => {
      events.error = err
    },
  }).then(() => events)
}

for (const web of [false, true]) {
  const label = web ? 'web stream' : 'node stream'

  test('sse-reader (' + label + '): [DONE] fires onDone exactly once', async () => {
    const events = await run(['data: {"a":1}\n\ndata: [DONE]\n\n'], { web })
    assert.deepStrictEqual(events.data, [{ a: 1 }])
    assert.strictEqual(events.done, 1)
  })

  test('sse-reader (' + label + '): flushes a trailing line without newline', async () => {
    const events = await run(['data: {"a":1}\n', 'data: {"b":2}'], { web })
    assert.deepStrictEqual(events.data, [{ a: 1 }, { b: 2 }])
    assert.strictEqual(events.done, 1)
  })

  test('sse-reader (' + label + '): strips CR and handles split chunks', async () => {
    const events = await run(['data: {"a":', '1}\r\n\r\n'], { web })
    assert.deepStrictEqual(events.data, [{ a: 1 }])
  })

  test('sse-reader (' + label + '): malformed JSON is dropped, stream continues', async () => {
    const events = await run(['data: {oops\n', 'data: {"ok":true}\n'], { web })
    assert.deepStrictEqual(events.data, [{ ok: true }])
    assert.strictEqual(events.done, 1)
  })
}
