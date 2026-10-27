'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const db = require('../../../core/state/db')
const users = require('../../../core/state/users')
const { createUser } = require('./model-helpers')

function openTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-users-'))
  const file = path.join(dir, 'zerokey.db')
  const handle = db.open({ file })
  return {
    dir,
    file,
    handle,
    cleanup() {
      users.flushAll(handle)
      if (handle.isOpen) handle.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

const CAPTURE = {
  url: 'https://chatgpt.com/backend-api/f/conversation',
  method: 'POST',
  headers: { Cookie: 'a=1', authorization: 'Bearer x', 'x-oai-is': 'one' },
  body: { client_contextual_info: { k: 1 } },
  bodyBase64: 'e30=',
  request: { url: 'legacy' },
}

test('updateCapture skips unchanged headers and merges changed ones', () => {
  const { handle, cleanup } = openTemp()
  try {
    const user = createUser(handle, 'chatgpt', 'cap', {
      parsedFetch: {
        url: 'https://chatgpt.com/backend-api/f/conversation',
        method: 'POST',
        headers: { cookie: 'a=1', authorization: 'Bearer x' },
        body: { k: 1 },
        bodyBase64: 'e30=',
      },
    })
    const same = {
      url: 'https://chatgpt.com/backend-api/f/conversation',
      method: 'POST',
      headers: { cookie: 'a=1', authorization: 'Bearer x' },
      body: { k: 1 },
    }
    assert.equal(users.updateCapture(handle, user.id, same), false)

    const changed = { ...same, headers: { cookie: 'a=2', authorization: 'Bearer x' } }
    assert.equal(users.updateCapture(handle, user.id, changed), true)
    users.flushAll(handle)

    const reread = handle.table('users').get(user.id)
    assert.equal(reread.parsedFetch.headers.cookie, 'a=2')
    assert.equal(reread.parsedFetch.bodyBase64, 'e30=')
    assert.equal(users.updateCapture(handle, 'missing-id', changed), false)
  } finally {
    cleanup()
  }
})

test('updateCapture persists a url or body change when headers are identical', () => {
  const { handle, cleanup } = openTemp()
  try {
    const headers = { cookie: 'a=1' }
    const user = createUser(handle, 'chatgpt', 'cap2', {
      parsedFetch: { url: 'https://a.test/x', method: 'POST', headers, body: { k: 1 } },
    })
    assert.equal(users.updateCapture(handle, user.id, { url: 'https://b.test/x', headers }), true)
    assert.equal(users.updateCapture(handle, user.id, { headers, body: { k: 2 } }), true)
    users.flushAll(handle)
    const reread = handle.table('users').get(user.id)
    assert.equal(reread.parsedFetch.url, 'https://b.test/x')
    assert.deepEqual(reread.parsedFetch.body, { k: 2 })
  } finally {
    cleanup()
  }
})

test('capture round-trips through capture columns and user_headers rows', () => {
  const t = openTemp()
  try {
    const user = createUser(t.handle, 'chatgpt', 'rt', { parsedFetch: CAPTURE })
    users.flushNow(t.handle, user)
    const reread = t.handle.table('users').get(user.id)
    assert.deepEqual(JSON.parse(JSON.stringify(reread.parsedFetch)), CAPTURE)
    assert.deepEqual(Object.keys(reread.parsedFetch.headers), [
      'Cookie',
      'authorization',
      'x-oai-is',
    ])
    const n = t.handle.prepare('SELECT COUNT(*) AS n FROM user_headers').get().n
    assert.equal(n, 3)
  } finally {
    t.cleanup()
  }
})

test('a header change upserts one row, removals delete, order is kept', () => {
  const t = openTemp()
  try {
    const user = createUser(t.handle, 'chatgpt', 'diff', { parsedFetch: CAPTURE })
    users.flushNow(t.handle, user)
    const live = t.handle.table('users').get(user.id)
    live.parsedFetch.headers.Cookie = 'a=2'
    delete live.parsedFetch.headers['x-oai-is']
    live.parsedFetch.headers['x-conduit-token'] = 'tok'
    users.flushNow(t.handle, live)
    const rows = t.handle
      .prepare('SELECT name, value, pos FROM user_headers WHERE user_id = ? ORDER BY pos')
      .all(user.id)
    assert.deepEqual(
      rows.map((r) => [r.name, r.value]),
      [
        ['Cookie', 'a=2'],
        ['authorization', 'Bearer x'],
        ['x-conduit-token', 'tok'],
      ],
    )
  } finally {
    t.cleanup()
  }
})

test('deleting a user cascades to user_headers', () => {
  const t = openTemp()
  try {
    const user = createUser(t.handle, 'chatgpt', 'gone', { parsedFetch: CAPTURE })
    users.flushNow(t.handle, user)
    t.handle.table('users').where({ id: user.id }).delete()
    assert.equal(t.handle.prepare('SELECT COUNT(*) AS n FROM user_headers').get().n, 0)
  } finally {
    t.cleanup()
  }
})

test('a v3 database is upgraded in place: parsed_fetch splits into capture_* + user_headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-old-'))
  const file = path.join(dir, 'zerokey.db')
  try {
    // Build a v3 database exactly as the previous code shipped it.
    const old = new DatabaseSync(file)
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE users (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, username TEXT NOT NULL,
        parsed_fetch TEXT NOT NULL, instructions_hash TEXT, instructions_applied_at INTEGER,
        wait_until INTEGER, wait_reason TEXT, state_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (provider, username)
      );
      CREATE TABLE sessions (
        user_id TEXT NOT NULL, name TEXT NOT NULL, id TEXT, parent_id TEXT,
        generation INTEGER NOT NULL DEFAULT 0, tool_calling INTEGER, vision INTEGER,
        model TEXT, transport TEXT, todos_json TEXT, turn_count INTEGER,
        dynamic_tools_hash TEXT, mcp_injected_json TEXT, state TEXT, metadata_json TEXT,
        last_token_usage INTEGER, usage_totals_json TEXT, last_used INTEGER,
        created_at INTEGER, state_json TEXT, updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, name),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id, last_used DESC);
    `)
    old.exec("INSERT INTO meta VALUES ('schema_version', '3')")
    const capture = {
      url: 'https://chatgpt.com/backend-api/f/conversation',
      method: 'POST',
      headers: { Cookie: 'a=1', authorization: 'Bearer x' },
      body: { k: 1 },
      bodyBase64: 'e30=',
      request: { url: 'legacy' },
    }
    old
      .prepare(
        'INSERT INTO users (id, provider, username, parsed_fetch, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('u1', 'chatgpt', 'rt', JSON.stringify(capture), JSON.stringify({ legacy: true }), 1, 2)
    old
      .prepare('INSERT INTO sessions (user_id, name, updated_at) VALUES (?, ?, ?)')
      .run('u1', 's1', 3)
    old.close()

    const fresh = db.open({ file })
    try {
      assert.equal(db.getVersion(fresh), db.SCHEMA_VERSION)
      const user = fresh.table('users').get('u1')
      assert.ok(user, 'user row survived the migration')
      assert.equal(user.parsedFetch.url, capture.url)
      assert.equal(user.parsedFetch.method, capture.method)
      assert.deepEqual(user.parsedFetch.body, capture.body)
      assert.equal(user.parsedFetch.bodyBase64, capture.bodyBase64)
      assert.deepEqual(user.parsedFetch.headers, capture.headers)
      const headerCount = fresh
        .prepare('SELECT COUNT(*) AS n FROM user_headers WHERE user_id = ?')
        .get('u1').n
      assert.equal(headerCount, 2)
      const session = fresh.prepare('SELECT name FROM sessions WHERE user_id = ?').get('u1')
      assert.equal(session.name, 's1', 'sessions FK survived the users rebuild')
      // A second open must be a no-op (idempotent migration).
      fresh.close()
      const again = db.open({ file })
      try {
        assert.equal(
          again.prepare('SELECT COUNT(*) AS n FROM user_headers WHERE user_id = ?').get('u1').n,
          2,
        )
      } finally {
        again.close()
      }
    } finally {
      if (fresh.isOpen) fresh.close()
    }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows can hold the -wal/-shm briefly after close; the temp dir is
      // disposable, so a cleanup miss must not fail the assertions above.
    }
  }
})
