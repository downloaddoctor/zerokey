'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

const registry = require('../../providers/registry')
const inception = require('../../providers/inception')
const { streamHandler } = require('../../providers/inception/stream-handler')
const { trimHistory } = require('../../providers/inception/router')

function frames(events) {
  return events.map((e) => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n')
}

function fakeParser() {
  const calls = { scan: [], chunks: [], final: 0, errors: [], text: [] }
  return {
    calls,
    compiler: { provider: 'inception' },
    scan: (t) => calls.scan.push(t),
    writeChunk: (c) => calls.chunks.push(c),
    sendFinalChunk: () => {
      calls.final++
    },
    emitText: (t) => calls.text.push(t),
    onError: (e) => calls.errors.push(e),
  }
}

test('registry auto-discovers the inception provider', () => {
  assert.equal(registry.get('inception'), inception)
  assert.ok(registry.getModels().mercury)
})

test('inception is authless: no capture is required and credentials always validate', async () => {
  assert.equal(inception.requiresCapture, false)
  assert.deepEqual(inception.validateFetch({}), [])
  assert.deepEqual(await inception.validateCredentials({}, 'some-user'), {
    success: true,
    user: 'some-user',
  })
})

test('streamHandler scans text deltas, forwards reasoning, finishes once', async () => {
  const parser = fakeParser()
  const stream = Readable.from(
    frames([
      { type: 'reasoning-start', id: 'reasoning-0' },
      { type: 'reasoning-delta', id: 'reasoning-0', delta: 'thinking' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'Hello' },
      { type: 'text-delta', id: 'text-0', delta: ' world' },
      { type: 'text-end', id: 'text-0' },
      '[DONE]',
    ]),
  )
  const reply = await streamHandler(stream, { id: 'chat-1' }, parser)
  assert.equal(reply, 'Hello world')
  assert.deepEqual(parser.calls.scan, ['Hello', ' world'])
  assert.equal(parser.calls.final, 1)
  assert.equal(parser.calls.chunks.at(-1).choices[0].delta.reasoning_content, 'thinking')
})

test('trimHistory keeps the first exchange and drops the oldest after it', () => {
  const big = 'x'.repeat(50_000)
  const mk = (role, text) => ({ role, parts: [{ type: 'text', text }] })
  const history = [
    mk('user', 'first'),
    mk('assistant', 'first-reply'),
    mk('user', big),
    mk('assistant', big),
    mk('user', big),
    mk('assistant', 'last'),
  ]
  trimHistory(history)
  assert.equal(history[0].parts[0].text, 'first')
  assert.equal(history.at(-1).parts[0].text, 'last')
  assert.ok(history.length < 6)
})
