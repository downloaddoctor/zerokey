'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.resolve(__dirname, '..')

test('CONFIG binds loopback and uses port 7250 by default', () => {
  const { CONFIG } = require('../config/constants')
  assert.equal(CONFIG.HOST, '127.0.0.1')
  assert.equal(CONFIG.PORT, 7250)
})

test('config rejects a numeric prefix with trailing junk', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./config/constants')"], {
    cwd: ROOT,
    env: { ...process.env, PORT: '7250junk' },
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
})

test('data dir lives outside the git-tracked tree', () => {
  const { CONFIG } = require('../config/constants')
  assert.ok(
    !path.resolve(CONFIG.DATA_DIR).startsWith(path.resolve(ROOT) + path.sep) ||
      path.basename(CONFIG.DATA_DIR) === 'temp',
    'expected DATA_DIR under temp/ or outside the repo',
  )
})

test('log.redact strips bearer, JWT, JSON token fields, data URLs, SAS params', () => {
  const { redact } = require('../utils/log')
  assert.match(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'), /<redacted>/)
  assert.doesNotMatch(redact('{"access":"abcdefghij","other":"visible"}'), /abcdefghij/)
  assert.match(redact('{"access":"abcdefghij","other":"visible"}'), /visible/)
  assert.doesNotMatch(redact('token=eyJhbGciOiJIUzI1NiJ9.payload'), /payload/)
  assert.match(redact('data:image/png;base64,iVBORw0KGgo'), /<redacted>/)
  assert.doesNotMatch(redact('https://x/y?sig=topsecret'), /topsecret/)
})

function cleanupDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix
    if (!fs.existsSync(f)) continue
    try {
      fs.unlinkSync(f)
    } catch (err) {
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err
    }
  }
}

test('SQLite schema_version gate refuses a newer version', () => {
  const db = require('../core/state/db')
  const file = path.join(ROOT, 'temp', 'schema-gate-test.db')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  cleanupDb(file)
  try {
    const first = db.open({ file })
    db.setMeta(first, 'schema_version', db.SCHEMA_VERSION + 1)
    first.close()
    assert.throws(() => db.open({ file }), /newer than the supported version/)
  } finally {
    cleanupDb(file)
  }
})

test('sessions.create then get round-trips a row', () => {
  const dbModule = require('../core/state/db')
  const users = require('../core/state/users')
  const sessions = require('../core/state/sessions')
  const file = path.join(ROOT, 'temp', 'sessions-roundtrip.db')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
    const db = dbModule.open({ file })
    const user = users.create(db, 'chatgpt', 'roundtrip-user', { parsedFetch: {} })
    const created = sessions.create(db, user.id, {
      name: 'sess-1',
      id: 'conv-1',
      parentId: 'msg-1',
    })
    sessions.flushNow(db, created)
    const loaded = sessions.get(db, user.id, 'sess-1')
    assert.equal(loaded.id, 'conv-1')
    assert.equal(loaded.parentId, 'msg-1')
    db.close()
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = file + suffix
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
  }
})

test('sessions.resolve creates a row for a new (userId, name)', () => {
  const dbModule = require('../core/state/db')
  const users = require('../core/state/users')
  const sessions = require('../core/state/sessions')
  const file = path.join(ROOT, 'temp', 'sessions-resolve.db')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
    const db = dbModule.open({ file })
    const user = users.create(db, 'deepseek', 'resolve-user', { parsedFetch: {} })
    const fresh = sessions.resolve(db, user.id, 'sess-2')
    assert.equal(fresh.userId, user.id)
    assert.equal(fresh.persistent, true)
    const again = sessions.resolve(db, user.id, 'sess-2')
    assert.equal(again.state, 'idle')
    db.close()
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = file + suffix
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
  }
})

test('start.js emits a PID lock with wx semantics', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'start.js'), 'utf8')
  assert.match(src, /fs\.openSync\(CONFIG\.LOCK_FILE, 'wx'\)/)
  assert.match(src, /healthBelongsToThisInstance/)
})

test('no Unix-only assumptions in the active code paths', () => {
  const patterns = [
    [/['"`]\/opt\//, 'absolute /opt path'],
    [/['"`]\/root\//, 'absolute /root path'],
    [/\/bin\/(?:ba)?sh/, 'shell from /bin'],
    [/\bchmod(?:Sync)?\s*\(/, 'chmod call'],
    [/\bchown(?:Sync)?\s*\(/, 'chown call'],
    [/\bmktemp\b/, 'mktemp call'],
  ]
  // Active tree only. `temp/` is runtime state (gitignored); its contents are
  // not code the repository owns.
  const DIRS = ['core', 'engine', 'routes', 'utils', 'config', 'scripts', 'surfaces', 'providers']
  const skip = new Set([
    path.resolve(__filename),
    path.resolve(path.join(ROOT, 'scripts', 'check-modules.js')),
  ])

  function walk(dir) {
    const out = []
    if (!fs.existsSync(dir)) return out
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      else if (entry.name.endsWith('.js')) out.push(full)
    }
    return out
  }

  const hits = []
  for (const dir of DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      if (skip.has(path.resolve(file))) continue
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const [pattern, label] of patterns) {
          if (pattern.test(line)) {
            hits.push(`${path.relative(ROOT, file)}:${i + 1} (${label})`)
          }
        }
      })
    }
  }
  assert.equal(hits.length, 0, hits.join(', '))
})

// Keep the import so the SQLite driver is probed at test-run time; a Node
// without node:sqlite must fail the suite here, not silently pass.
test('node:sqlite is available', () => {
  assert.equal(typeof DatabaseSync, 'function')
})
