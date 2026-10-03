'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const dbModule = require('../../../core/state/db')
const users = require('../../../core/state/users')
const sessions = require('../../../core/state/sessions')

const scratch = path.join(ROOT, 'temp', 'test', 'compaction-test.db')

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = scratch + suffix
    if (!fs.existsSync(f)) continue
    try {
      fs.unlinkSync(f)
    } catch {}
  }
}

function freshDb() {
  cleanup()
  fs.mkdirSync(path.dirname(scratch), { recursive: true })
  const db = dbModule.open({ file: scratch })
  const user = users.create(db, 'chatgpt', 'compaction-user', {
    parsedFetch: { url: 'x', method: 'POST', headers: {}, body: '{}' },
  })
  return { db, user }
}

test('generation 0 keeps the existing conversation', () => {
  const { db, user } = freshDb()
  try {
    const created = sessions.create(db, user.id, {
      name: 'sess-keep',
      id: 'conv-1',
      parentId: 'msg-1',
      generation: 0,
    })
    sessions.flushNow(db, created)
    const row = sessions.resolve(db, user.id, 'sess-keep', { generation: 0 })
    assert.equal(row.id, 'conv-1')
    assert.equal(row.parentId, 'msg-1')
  } finally {
    db.close()
    cleanup()
  }
})

test('higher generation rebinds and stashes the previous conversation', () => {
  const { db, user } = freshDb()
  try {
    const created = sessions.create(db, user.id, {
      name: 'sess-rebind',
      id: 'conv-old',
      parentId: 'msg-old',
      generation: 0,
    })
    sessions.flushNow(db, created)
    const row = sessions.resolve(db, user.id, 'sess-rebind', { generation: 1 })
    assert.equal(row.id, null)
    assert.equal(row.parentId, null)
    assert.equal(row.generation, 1)
    assert.equal(row.state, 'rebased')
    assert.deepEqual(row.metadata.pendingPreviousConversationIds, ['conv-old'])
  } finally {
    db.close()
    cleanup()
  }
})

test('lower generation is ignored', () => {
  const { db, user } = freshDb()
  try {
    const created = sessions.create(db, user.id, {
      name: 'sess-lower',
      id: 'conv-2',
      generation: 2,
    })
    sessions.flushNow(db, created)
    const row = sessions.resolve(db, user.id, 'sess-lower', { generation: 1 })
    assert.equal(row.id, 'conv-2')
    assert.equal(row.generation, 2)
  } finally {
    db.close()
    cleanup()
  }
})

test('successive bumps accumulate pending conversation ids', () => {
  const { db, user } = freshDb()
  try {
    const first = sessions.create(db, user.id, {
      name: 'sess-accum',
      id: 'conv-a',
      generation: 0,
    })
    sessions.flushNow(db, first)
    sessions.resolve(db, user.id, 'sess-accum', { generation: 1 })

    const second = sessions.get(db, user.id, 'sess-accum')
    second.id = 'conv-b'
    second.metadata = { pendingPreviousConversationIds: ['conv-a'] }
    sessions.flushNow(db, second)

    const row = sessions.resolve(db, user.id, 'sess-accum', { generation: 2 })
    assert.equal(row.id, null)
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
