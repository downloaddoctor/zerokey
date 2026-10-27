'use strict'

/**
 * Users: identity, credentials, and the rate-limit/instructions fields.
 *
 * Persistence and the recursive Proxy live in sqlite-pro; this module
 * supplies the table config and the user-specific domain functions. Assigning
 * to any field (nested plain objects and arrays included, e.g.
 * `user.parsedFetch.headers.cookie = x`) schedules a debounced 250 ms flush.
 *
 * parsedFetch is a virtual field: it has no column. Its static part (url,
 * method, body, bodyBase64, any other key) is projected onto users.capture_*
 * and its headers onto one user_headers row each, so a refreshed cookie
 * rewrites one row. JS callers still see a single parsedFetch object.
 */

const { randomUUID } = require('crypto')
const { createStore } = require('sqlite-pro')

const SCHEMA = {
  columns: {
    id: 'text primary',
    provider: 'text required',
    username: 'text required',
    captureUrl: 'text',
    captureMethod: 'text',
    captureBody: { type: 'json', column: 'capture_body' },
    captureBodyBase64: 'text',
    captureExtra: { type: 'json', column: 'capture_extra' },
    instructionsHash: 'text',
    instructionsAppliedAt: 'integer',
    waitUntil: 'integer',
    waitReason: 'text',
    createdAt: 'integer required',
    updatedAt: 'integer required',
  },
  unique: ['provider+username'],
  virtual: {
    parsedFetch: {
      fields: {
        url: 'captureUrl',
        method: 'captureMethod',
        body: 'captureBody',
        bodyBase64: 'captureBodyBase64',
      },
      extra: 'captureExtra',
      children: {
        headers: {
          table: 'user_headers',
          parent: 'userId',
          key: 'name',
          value: 'value',
          order: 'pos',
        },
      },
    },
  },
  children: [
    {
      table: 'user_headers',
      schema: {
        columns: {
          userId: 'text required ->users.id:cascade',
          name: 'text required',
          value: 'text required',
          pos: 'integer required',
        },
        primaryKey: 'userId+name',
        withoutRowid: true,
      },
    },
  ],
}

const store = createStore({
  schema: SCHEMA,
  table: 'users',
  conflict: ['id'],
  keyOf: (user) => user.id,
  flushMs: 250,
  label: 'users',
  stateColumn: null,
  beforeCreate: prepareUser,
})

// create() hook: id, lowercase provider, empty capture, explicit nulls.
function prepareUser(user) {
  user.id = user.id || randomUUID()
  user.provider = String(user.provider).toLowerCase()
  user.username = String(user.username)
  user.parsedFetch = user.parsedFetch || {}
  for (const key of ['instructionsHash', 'instructionsAppliedAt', 'waitUntil', 'waitReason']) {
    if (user[key] === undefined) user[key] = null
  }
}

// Persist a refreshed capture from a provider client. Merges onto the stored
// capture (keeps keys the client does not resend, e.g. bodyBase64) and skips
// the write when no key in next differs. Returns true when a write was queued.
function updateCapture(db, id, next) {
  if (!next || typeof next !== 'object') return false
  const user = db.table('users').get(id)
  if (!user) return false
  const current = JSON.parse(JSON.stringify(user.parsedFetch || {}))
  const unchanged = Object.keys(next).every(
    (key) => JSON.stringify(current[key] ?? null) === JSON.stringify(next[key] ?? null),
  )
  if (unchanged) return false
  user.parsedFetch = { ...current, ...next }
  return true
}

module.exports = Object.assign(store, { SCHEMA, updateCapture })
