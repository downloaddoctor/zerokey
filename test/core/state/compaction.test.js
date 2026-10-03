'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const dbModule = require('../../../core/state/db')
const sessions = require('../../../core/state/sessions')

const scratch = path.join(ROOT, 'temp', 'compaction-test.db')

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = scratch + suffix
    if (!fs.existsSync(f)) continue
    try {
      fs.unlinkSync(f)
    } catch {}
  }
}

test('generation 0 keeps the existing upstream conversation', () => {
  cleanup()
  fs.mkdirSync(path.dirname(scratch), { recursive: true })
  const db = dbModule.open({ file: scratch })
  try {
    sessions.save(db, {
      provider: 'chatgpt',
      id: 'sess-keep',
      upstreamConversationId: 'conv-1',
      upstreamParentMessageId: 'msg-1',
      generation: 0,
    })
    const row = sessions.resolve(db, 'chatgpt', 'sess-keep', { generation: 0 })
    assert.equal(row.upstreamConversationId, 'conv-1')
    assert.equal(row.upstreamParentMessageId, 'msg-1')
  } finally {
    db.close()
    cleanup()
  }
})

test('higher generation rebinds and stashes the previous conversation', () => {
  cleanup()
  const db = dbModule.open({ file: scratch })
  try {
    sessions.save(db, {
      provider: 'chatgpt',
      id: 'sess-rebind',
      upstreamConversationId: 'conv-old',
      upstreamParentMessageId: 'msg-old',
      generation: 0,
    })
    const row = sessions.resolve(db, 'chatgpt', 'sess-rebind', { generation: 1 })
    assert.equal(row.upstreamConversationId, null)
    assert.equal(row.upstreamParentMessageId, null)
    assert.equal(row.generation, 1)
    assert.equal(row.state, 'rebased')
    assert.deepEqual(row.metadata.pendingPreviousConversationIds, ['conv-old'])
  } finally {
    db.close()
    cleanup()
  }
})

test('lower generation is ignored', () => {
  cleanup()
  const db = dbModule.open({ file: scratch })
  try {
    sessions.save(db, {
      provider: 'chatgpt',
      id: 'sess-lower',
      upstreamConversationId: 'conv-2',
      generation: 2,
    })
    const row = sessions.resolve(db, 'chatgpt', 'sess-lower', { generation: 1 })
    assert.equal(row.upstreamConversationId, 'conv-2')
    assert.equal(row.generation, 2)
  } finally {
    db.close()
    cleanup()
  }
})

test('successive bumps accumulate pending conversation ids', () => {
  cleanup()
  const db = dbModule.open({ file: scratch })
  try {
    sessions.save(db, {
      provider: 'chatgpt',
      id: 'sess-accum',
      upstreamConversationId: 'conv-a',
      generation: 0,
    })
    sessions.resolve(db, 'chatgpt', 'sess-accum', { generation: 1 })
    // Simulate the next successful turn binding a new conversation.
    sessions.save(db, {
      provider: 'chatgpt',
      id: 'sess-accum',
      upstreamConversationId: 'conv-b',
      generation: 1,
      metadata: { pendingPreviousConversationIds: ['conv-a'] },
    })
    const row = sessions.resolve(db, 'chatgpt', 'sess-accum', { generation: 2 })
    assert.equal(row.upstreamConversationId, null)
    const pending = row.metadata.pendingPreviousConversationIds
    assert.ok(pending.includes('conv-a'))
    assert.ok(pending.includes('conv-b'))
  } finally {
    db.close()
    cleanup()
  }
})

test('normalizeGeneration rejects negative, fractional, and unsafe', () => {
  assert.equal(sessions.normalizeGeneration(-1), 0)
  assert.equal(sessions.normalizeGeneration(1.5), 0)
  assert.equal(sessions.normalizeGeneration(Number.MAX_SAFE_INTEGER + 1), 0)
  assert.equal(sessions.normalizeGeneration(5), 5)
})

test('headers.read picks the zerokey variant before the opencode one', () => {
  const headers = require('../../../utils/headers')
  const result = headers.read({
    'x-zerokey-compaction-generation': '7',
    'x-opencode-compaction-generation': '3',
  })
  assert.equal(result.generation, 7)
})

test('headers.read clamps an invalid generation to 0', () => {
  const headers = require('../../../utils/headers')
  assert.equal(headers.read({ 'x-zerokey-compaction-generation': 'abc' }).generation, 0)
  assert.equal(headers.read({ 'x-zerokey-compaction-generation': '-3' }).generation, 0)
  assert.equal(headers.read({}).generation, 0)
})
