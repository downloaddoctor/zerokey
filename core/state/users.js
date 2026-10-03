'use strict'

/**
 * Users: identity, credentials, and the rate-limit/instructions fields.
 *
 * Rows are materialized as plain objects and wrapped in a Proxy. Assigning
 * to any field persists the change (debounced 50 ms) without the caller
 * ever seeing SQL. Nested writes to parsedFetch.headers are not intercepted:
 * assign user.parsedFetch = nextCapture to persist a fresh capture.
 */

const { randomUUID } = require('crypto')

const COLUMN_MAP = {
  id: 'id',
  provider: 'provider',
  username: 'username',
  parsedFetch: 'parsed_fetch',
  instructionsHash: 'instructions_hash',
  instructionsAppliedAt: 'instructions_applied_at',
  waitUntil: 'wait_until',
  waitReason: 'wait_reason',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
}

const BLOB_KEYS = new Set(['parsedFetch'])
const FLUSH_MS = 50
const SELECT_COLUMNS =
  'id, provider, username, parsed_fetch, instructions_hash, ' +
  'instructions_applied_at, wait_until, wait_reason, state_json, created_at, updated_at'

const pending = new Map()

function parseBlob(value, fallback) {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function rowToUser(row) {
  if (!row) return null
  const state = parseBlob(row.state_json, {})
  const user = {
    id: row.id,
    provider: row.provider,
    username: row.username,
    parsedFetch: parseBlob(row.parsed_fetch, {}),
    instructionsHash: row.instructions_hash ?? null,
    instructionsAppliedAt: row.instructions_applied_at ?? null,
    waitUntil: row.wait_until ?? null,
    waitReason: row.wait_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  for (const [key, value] of Object.entries(state)) {
    if (!(key in user)) user[key] = value
  }
  return user
}

function columnProjection(user) {
  const columns = {}
  const state = {}
  for (const [key, value] of Object.entries(user)) {
    const column = COLUMN_MAP[key]
    if (!column) {
      state[key] = value
      continue
    }
    if (BLOB_KEYS.has(key)) {
      columns[column] = value === null || value === undefined ? null : JSON.stringify(value)
    } else if (typeof value === 'boolean') {
      columns[column] = value ? 1 : 0
    } else if (value === undefined) {
      columns[column] = null
    } else {
      columns[column] = value
    }
  }
  return {
    columns,
    state: Object.keys(state).length === 0 ? null : JSON.stringify(state),
  }
}

function flush(db, user) {
  const { columns, state } = columnProjection(user)
  columns.state_json = state
  columns.updated_at = Date.now()
  user.updatedAt = columns.updated_at

  const names = Object.keys(columns)
  const placeholders = names.map(() => '?').join(', ')
  const updates = names.map((n) => n + ' = excluded.' + n).join(', ')
  db.prepare(
    'INSERT INTO users (' +
      names.join(', ') +
      ') VALUES (' +
      placeholders +
      ') ON CONFLICT(id) DO UPDATE SET ' +
      updates,
  ).run(...names.map((n) => columns[n]))
}

function schedule(db, user) {
  const id = user.id
  if (pending.has(id)) return
  pending.set(
    id,
    setTimeout(() => {
      pending.delete(id)
      try {
        flush(db, user)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        if (!/database is not open/i.test(message)) {
          console.error('users flush failed: ' + message)
        }
      }
    }, FLUSH_MS),
  )
}

function wrap(db, user) {
  return new Proxy(user, {
    set(target, key, value) {
      if (typeof key !== 'string' || key === 'updatedAt' || key === 'createdAt') {
        target[key] = value
        return true
      }
      target[key] = value
      schedule(db, target)
      return true
    },
    deleteProperty(target, key) {
      delete target[key]
      schedule(db, target)
      return true
    },
  })
}

function get(db, provider, username) {
  const row = db
    .prepare('SELECT ' + SELECT_COLUMNS + ' FROM users WHERE provider = ? AND username = ?')
    .get(String(provider).toLowerCase(), String(username))
  if (!row) return null
  return wrap(db, rowToUser(row))
}

function getById(db, id) {
  const row = db.prepare('SELECT ' + SELECT_COLUMNS + ' FROM users WHERE id = ?').get(id)
  if (!row) return null
  return wrap(db, rowToUser(row))
}

function list(db) {
  return db
    .prepare('SELECT ' + SELECT_COLUMNS + ' FROM users ORDER BY provider, username')
    .all()
    .map(rowToUser)
}

function create(db, provider, username, fields = {}) {
  const now = Date.now()
  const user = {
    id: randomUUID(),
    provider: String(provider).toLowerCase(),
    username: String(username),
    parsedFetch: fields.parsedFetch || {},
    instructionsHash: fields.instructionsHash ?? null,
    instructionsAppliedAt: fields.instructionsAppliedAt ?? null,
    waitUntil: fields.waitUntil ?? null,
    waitReason: fields.waitReason ?? null,
    createdAt: fields.createdAt ?? now,
    updatedAt: now,
  }
  flush(db, user)
  return wrap(db, user)
}

function upsert(db, provider, username, fields = {}) {
  const existing = get(db, provider, username)
  if (existing) {
    for (const [key, value] of Object.entries(fields)) existing[key] = value
    return existing
  }
  return create(db, provider, username, fields)
}

function remove(db, id) {
  if (pending.has(id)) {
    clearTimeout(pending.get(id))
    pending.delete(id)
  }
  return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes
}

function flushNow(db, user) {
  if (pending.has(user.id)) {
    clearTimeout(pending.get(user.id))
    pending.delete(user.id)
  }
  flush(db, user)
}

module.exports = {
  BLOB_KEYS,
  COLUMN_MAP,
  create,
  flush,
  flushNow,
  get,
  getById,
  list,
  remove,
  rowToUser,
  upsert,
}
