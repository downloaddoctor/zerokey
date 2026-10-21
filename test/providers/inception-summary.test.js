'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

const config = require('../../providers/inception/config')
const { collectReply } = require('../../providers/inception/stream-handler')

function frames(events) {
  return events.map((e) => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n')
}

test('inception summaryAt is the 95th prompt', () => {
  assert.equal(config.summaryAt, 95)
})

test('collectReply returns only the text deltas, silently', async () => {
  const stream = Readable.from(
    frames([
      { type: 'reasoning-delta', id: 'reasoning-0', delta: 'thinking' },
      { type: 'text-delta', id: 'text-0', delta: 'Sum' },
      { type: 'text-delta', id: 'text-0', delta: 'mary' },
      '[DONE]',
    ]),
  )
  assert.equal(await collectReply(stream), 'Summary')
})

test('collectReply rejects on an upstream error frame', async () => {
  const stream = Readable.from(frames([{ type: 'error', errorText: 'boom' }, '[DONE]']))
  await assert.rejects(collectReply(stream), /boom/)
})
