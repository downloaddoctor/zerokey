'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

const { claudeStreamHandler } = require('../../providers/claude/stream-handler')

function frames(events) {
  return events.map((e) => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n')
}

function fakeParser() {
  const calls = { scan: [], chunks: [], final: 0, errors: [], text: [], emitted: [] }
  return {
    calls,
    compiler: { provider: 'claude' },
    tokenUsage: {},
    scan: (t) => calls.scan.push(t),
    writeChunk: (c) => calls.chunks.push(c),
    sendFinalChunk: () => {
      calls.final++
    },
    emitText: (t) => calls.text.push(t),
    emit: (d) => calls.emitted.push(d),
    onError: (e) => calls.errors.push(e),
  }
}

test('streams text deltas, scans them, finishes once', async () => {
  const parser = fakeParser()
  const stream = Readable.from(
    frames([
      { type: 'message_start', message: { uuid: 'u-1' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ]),
  )
  const session = { parentId: null }
  await claudeStreamHandler(stream, session, parser)
  assert.equal(session.parentId, 'u-1')
  assert.deepEqual(parser.calls.scan, ['Hello', ' world'])
  assert.equal(parser.calls.final, 1)
  assert.deepEqual(parser.calls.errors, [])
})

test('forwards cumulative thinking_summary_delta as the growing tail only', async () => {
  const parser = fakeParser()
  const stream = Readable.from(
    frames([
      { type: 'message_start', message: { uuid: 'u-2' } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', summaries: [] },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_summary_delta', summary: { summary: 'Planning premium' } },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'thinking_summary_delta',
          summary: { summary: 'Planning premium character selection' },
        },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done' } },
      { type: 'message_stop' },
    ]),
  )
  await claudeStreamHandler(stream, { parentId: null }, parser)
  assert.deepEqual(parser.calls.scan, ['Done'])
  // First emit is the role-only frame, then each new summary tail.
  assert.deepEqual(parser.calls.emitted[0], { role: 'assistant', reasoning_content: '' })
  const reasoning = parser.calls.emitted
    .filter((d) => d.reasoning_content !== undefined && d.reasoning_content !== '')
    .map((d) => d.reasoning_content)
  assert.deepEqual(reasoning, ['Planning premium', ' character selection'])
  assert.equal(parser.calls.final, 1)
  assert.deepEqual(parser.calls.errors, [])
})

test('emits thinking text delivered on content_block_start', async () => {
  const parser = fakeParser()
  const stream = Readable.from(
    frames([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'Pondering' },
      },
      { type: 'message_stop' },
    ]),
  )
  await claudeStreamHandler(stream, { parentId: null }, parser)
  const reasoning = parser.calls.emitted
    .filter((d) => d.reasoning_content !== undefined && d.reasoning_content !== '')
    .map((d) => d.reasoning_content)
  assert.deepEqual(reasoning, ['Pondering'])
})

test('surfaces a plain stream error via parser.onError', async () => {
  const parser = fakeParser()
  const stream = Readable.from(
    frames([{ type: 'error', error: { type: 'api_error', message: 'boom' } }]),
  )
  await claudeStreamHandler(stream, { parentId: null }, parser)
  assert.equal(parser.calls.errors.length, 1)
  assert.match(parser.calls.errors[0].message, /Claude stream error: boom/)
})
