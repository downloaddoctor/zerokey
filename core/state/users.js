'use strict'

/**
 * Users: identity, credentials, and the rate-limit/instructions fields.
 *
 * Persistence and the recursive Proxy live in core/state/store.js; this module
 * supplies the table config and the user-specific domain functions. Assigning
 * to any field (nested plain objects and arrays included, e.g.
 * `user.parsedFetch.headers.cookie = x`) schedules a debounced 250 ms flush.
 */

const { randomUUID } = require('crypto')
const { createStore, parseBlob } = require('./store')

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
const SELECT_COLUMNS =
  'id, provider, username, parsed_fetch, instructions_hash, ' +
  'instructions_applied_at, wait_until, wait_reason, state_json, created_at, updated_at'

const store = createStore({
  table: 'users',
  columnMap: COLUMN_MAP,
  blobKeys: BLOB_KEYS,
  conflict: ['id'],
  keyOf: (user) => user.id,
  flushMs: 250,
  label: 'users',
})

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

function get(db, provider, username) {
  const row = db
    .prepare('SELECT ' + SELECT_COLUMNS + ' FROM users WHERE provider = ? AND username = ?')
    .get(String(provider).toLowerCase(), String(username))
  if (!row) return null
  return store.wrap(db, rowToUser(row))
}

function getById(db, id) {
  const row = db.prepare('SELECT ' + SELECT_COLUMNS + ' FROM users WHERE id = ?').get(id)
  if (!row) return null
  return store.wrap(db, rowToUser(row))
}

function list(db) {
  return db
    .prepare('SELECT ' + SELECT_COLUMNS + ' FROM users ORDER BY provider, username')
    .all()
    .map((row) => store.wrap(db, rowToUser(row)))
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
  store.flush(db, user)
  return store.wrap(db, user)
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
  store.cancel(id)
  return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes
}

module.exports = {
  BLOB_KEYS,
  COLUMN_MAP,
  create,
  flush: store.flush,
  flushAll: store.flushAll,
  flushNow: store.flushNow,
  get,
  getById,
  list,
  remove,
  rowToUser,
  upsert,
}
