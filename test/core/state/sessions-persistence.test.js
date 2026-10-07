'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const dbModule = require('../../../core/state/db')
const users = require('../../../core/state/users')
const sessions = require('../../../core/state/sessions')

const scratch = path.join(ROOT, 'temp', 'test', 'sessions-persistence-test.db')

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
  const user = users.create(db, 'claude', 'sessions-persistence', {
    parsedFetch: { url: 'x', headers: {} },
  })
  return { db, user }
}

test('nested metadata write is drained by sessions.flushAll', () => {
  const { db, user } = freshDb()
  try {
    sessions.create(db, user.id, { name: 'nested' })
    const session = sessions.get(db, user.id, 'nested')
    session.metadata.note = 'hello'
    sessions.flushAll()
    const reread = sessions.get(db, user.id, 'nested')
    assert.equal(reread.metadata.note, 'hello')
  } finally {
    db.close()
    cleanup()
  }
})

test('users.flushAll drains a pending top-level write', () => {
  const { db, user } = freshDb()
  try {
    const live = users.get(db, 'claude', 'sessions-persistence')
    live.waitUntil = 123
    users.flushAll()
    assert.equal(users.get(db, 'claude', 'sessions-persistence').waitUntil, 123)
    assert.equal(user.id, live.id)
  } finally {
    db.close()
    cleanup()
  }
})

test('rebase on a proxied row persists id reset and stashed conversation', () => {
  const { db, user } = freshDb()
  try {
    sessions.create(db, user.id, { name: 'rebase', id: 'conv-1', parentId: 'msg-1' })
    const session = sessions.get(db, user.id, 'rebase')
    sessions.rebase(session, 2)
    sessions.flushAll()
    const reread = sessions.get(db, user.id, 'rebase')
    assert.equal(reread.generation, 2)
    assert.equal(reread.id, null)
    assert.equal(reread.parentId, null)
    assert.deepEqual(reread.metadata.pendingPreviousConversationIds, ['conv-1'])
  } finally {
    db.close()
    cleanup()
  }
})

test('non-plain values (Date) pass through the deep proxy untouched', () => {
  const { db } = freshDb()
  try {
    const live = users.get(db, 'claude', 'sessions-persistence')
    live.stamp = new Date(5)
    assert.ok(live.stamp instanceof Date)
    assert.equal(live.stamp.getTime(), 5)
  } finally {
    users.flushAll()
    db.close()
    cleanup()
  }
})
