'use strict'

/**
 * v3 -> v4 data migration, Dexie-style: the step builds the target table
 * itself, copies the rows through the typed context, then swaps names. No
 * probe of the live users shape is needed, because nothing is renamed until
 * the new table already exists under a temp name.
 *
 * v3 users held the whole captured request in users.parsed_fetch (JSON) plus
 * extra user fields in users.state_json. v4 splits that into static capture_*
 * columns plus a user_headers child table (one row per header, so a refreshed
 * cookie is a one-row upsert). sessions is unchanged.
 *
 * Runs as a beforeDefine ladder step: foreign keys are OFF and the declared
 * schema has not run yet. Returning false means nothing changed.
 */

const CAPTURE_KNOWN = new Set(['url', 'method', 'headers', 'body', 'bodyBase64'])

function parseJson(text) {
  if (typeof text !== 'string' || text === '') return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function captureColumns(capture) {
  const value = capture && typeof capture === 'object' ? capture : {}
  const extra = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!CAPTURE_KNOWN.has(key) && entry !== undefined) extra[key] = entry
  }
  return {
    captureUrl: typeof value.url === 'string' ? value.url : null,
    captureMethod: typeof value.method === 'string' ? value.method : null,
    captureBody: value.body === undefined ? null : value.body,
    captureBodyBase64: typeof value.bodyBase64 === 'string' ? value.bodyBase64 : null,
    captureExtra: Object.keys(extra).length === 0 ? null : extra,
  }
}

// A v3 users table carries parsed_fetch and no capture_url. Only used to skip
// the step for a database that already has the v4 shape; the ladder schema_version
// check is what normally decides whether this step runs. Probes go through the
// sqlite-pro migration context, no hand-written SQL.
function isLegacyV3(ctx) {
  return ctx.hasColumn('users', 'parsed_fetch') && !ctx.hasColumn('users', 'capture_url')
}

// Map one decoded v3 row to the v4 users document. The migration context reads
// the renamed-away table through PRAGMA introspection (no store), so blob
// columns arrive as strings; parse them before the store's typed insert.
function legacyToV4(legacy) {
  const capture = parseJson(legacy.parsedFetch) || {}
  const extraState = parseJson(legacy.stateJson) || {}
  const mergedExtra = { ...extraState, ...(capture.request ? { request: capture.request } : {}) }
  const headers = capture.headers && typeof capture.headers === 'object' ? capture.headers : {}
  return {
    id: legacy.id,
    provider: legacy.provider,
    username: legacy.username,
    ...captureColumns({ ...capture, ...mergedExtra }),
    instructionsHash: legacy.instructionsHash,
    instructionsAppliedAt: legacy.instructionsAppliedAt,
    waitUntil: legacy.waitUntil,
    waitReason: legacy.waitReason,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    parsedFetch: { ...capture, ...mergedExtra, headers },
  }
}

function upgradeV3ToV4(db, ctx) {
  if (!isLegacyV3(ctx)) return false

  // Rename the v3 table aside, then let the declared schema build the v4
  // table under the real name. The store's virtual sync (user_headers) only
  // runs for its own table, so ctx.copy inserts each legacy row through the
  // users store and the child headers land in user_headers. The old table is
  // dropped only after every row copied, and the whole step is inside a
  // savepoint, so a failure leaves v3 untouched.
  const TEMP = 'users_v3_old'
  const usersStore = ctx.storeFor('users')
  if (!usersStore) throw new Error('v3->v4 migration: users store not found')
  ctx.rename('users', TEMP)
  usersStore.define(db)
  ctx.copy('users', TEMP, legacyToV4)
  ctx.drop(TEMP)
  return true
}

module.exports = { upgradeV3ToV4, isLegacyV3 }
