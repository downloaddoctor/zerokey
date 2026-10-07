'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const dbModule = require('../../../core/state/db')
const users = require('../../../core/state/users')

const scratch = path.join(ROOT, 'temp', 'test', 'users-persistence-test.db')

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
  return dbModule.open({ file: scratch })
}

test('list() returns Proxy-wrapped rows that persist waitUntil', () => {
  const db = freshDb()
  try {
    const created = users.create(db, 'claude', 'proxy-list', {
      parsedFetch: { url: 'x', method: 'POST', headers: {}, body: '{}' },
    })
    users.flushNow(db, created)
    const [fromList] = users.list(db).filter((u) => u.username === 'proxy-list')
    const until = Date.now() + 60_000
    fromList.waitUntil = until
    fromList.waitReason = 'Claude rate limit'
    users.flushNow(db, fromList)
    const reread = users.get(db, 'claude', 'proxy-list')
    assert.equal(reread.waitUntil, until)
    assert.equal(reread.waitReason, 'Claude rate limit')
  } finally {
    db.close()
    cleanup()
  }
})

test('nested write into parsedFetch.headers persists', () => {
  const db = freshDb()
  try {
    const created = users.create(db, 'claude', 'nested-write', {
      parsedFetch: { url: 'x', headers: { cookie: 'old' } },
    })
    users.flushNow(db, created)
    const [fromList] = users.list(db).filter((u) => u.username === 'nested-write')
    fromList.parsedFetch.headers.cookie = 'fresh'
    users.flushNow(db, fromList)
    const reread = users.get(db, 'claude', 'nested-write')
    assert.equal(reread.parsedFetch.headers.cookie, 'fresh')
  } finally {
    db.close()
    cleanup()
  }
})

test('nested write schedules a debounced flush without flushNow', async () => {
  const db = freshDb()
  try {
    const created = users.create(db, 'claude', 'nested-debounce', {
      parsedFetch: { url: 'x', headers: {} },
    })
    users.flushNow(db, created)
    const user = users.get(db, 'claude', 'nested-debounce')
    user.parsedFetch.headers.cookie = 'debounced'
    // Poll for the debounced flush instead of a fixed sleep; the 250 ms timer
    // can slip past a 120 ms wall clock under load.
    let reread = users.get(db, 'claude', 'nested-debounce')
    for (let i = 0; i < 40 && reread.parsedFetch.headers.cookie !== 'debounced'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      reread = users.get(db, 'claude', 'nested-debounce')
    }
    assert.equal(reread.parsedFetch.headers.cookie, 'debounced')
  } finally {
    users.flushNow(db, users.get(db, 'claude', 'nested-debounce'))
    db.close()
    cleanup()
  }
})

test('upsert on a listed user persists parsedFetch reassignment', () => {
  const db = freshDb()
  try {
    const created = users.create(db, 'claude', 'proxy-refresh', {
      parsedFetch: { url: 'old' },
    })
    users.flushNow(db, created)
    const [fromList] = users.list(db).filter((u) => u.username === 'proxy-refresh')
    fromList.parsedFetch = { url: 'new', headers: { cookie: 'fresh' } }
    users.flushNow(db, fromList)
    const reread = users.get(db, 'claude', 'proxy-refresh')
    assert.deepEqual(reread.parsedFetch, { url: 'new', headers: { cookie: 'fresh' } })
  } finally {
    db.close()
    cleanup()
  }
})
