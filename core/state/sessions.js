'use strict'

/**
 * Sessions: one row per (user, session name).
 *
 * Column names are snake_case; the JS object is camelCase. Persistence and the
 * recursive Proxy live in core/state/store.js; this module supplies the table
 * config and the session-specific domain functions. Writes (nested plain
 * objects/arrays included) are debounced 250 ms.
 *
 * Compaction: when a caller reports a higher generation than the row holds,
 * id and parentId are cleared and the old id is appended to
 * metadata.pendingPreviousConversationIds.
 */

const { createStore, parseBlob } = require('./store')

const COLUMN_MAP = {
  userId: 'user_id',
  name: 'name',
  id: 'id',
  parentId: 'parent_id',
  generation: 'generation',
  toolCalling: 'tool_calling',
  vision: 'vision',
  model: 'model',
  todos: 'todos_json',
  turnCount: 'turn_count',
  dynamicToolsHash: 'dynamic_tools_hash',
  mcpInjected: 'mcp_injected_json',
  state: 'state',
  metadata: 'metadata_json',
  lastTokenUsage: 'last_token_usage',
  usageTotals: 'usage_totals_json',
  lastUsed: 'last_used',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
}

const BLOB_KEYS = new Set(['todos', 'metadata', 'mcpInjected', 'usageTotals'])
const MAX_GENERATION = Number.MAX_SAFE_INTEGER
const SELECT_COLUMNS =
  'user_id, name, id, parent_id, generation, tool_calling, vision, model, ' +
  'todos_json, turn_count, dynamic_tools_hash, mcp_injected_json, state, metadata_json, ' +
  'last_token_usage, usage_totals_json, last_used, created_at, state_json, updated_at'

const keyFor = (userId, name) => userId + '\u0000' + name

const store = createStore({
  table: 'sessions',
  columnMap: COLUMN_MAP,
  blobKeys: BLOB_KEYS,
  conflict: ['user_id', 'name'],
  keyOf: (session) => keyFor(session.userId, session.name),
  flushMs: 250,
  label: 'sessions',
})

function normalizeGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_GENERATION ? value : 0
}

function rowToSession(row) {
  if (!row) return null
  const state = parseBlob(row.state_json, {})
  const session = {
    userId: row.user_id,
    name: row.name,
    id: row.id ?? null,
    parentId: row.parent_id ?? null,
    generation: normalizeGeneration(row.generation),
    toolCalling:
      row.tool_calling === null || row.tool_calling === undefined ? null : row.tool_calling === 1,
    vision: row.vision === null || row.vision === undefined ? null : row.vision === 1,
    model: row.model ?? null,
    todos: parseBlob(row.todos_json, null),
    turnCount: row.turn_count ?? null,
    dynamicToolsHash: row.dynamic_tools_hash ?? null,
    mcpInjected: parseBlob(row.mcp_injected_json, null),
    state: row.state ?? null,
    metadata: parseBlob(row.metadata_json, {}),
    lastTokenUsage: row.last_token_usage ?? null,
    usageTotals: parseBlob(row.usage_totals_json, null),
    lastUsed: row.last_used ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at,
  }
  for (const [key, value] of Object.entries(state)) {
    if (!(key in session)) session[key] = value
  }
  return session
}

function get(db, userId, name) {
  const row = db
    .prepare('SELECT ' + SELECT_COLUMNS + ' FROM sessions WHERE user_id = ? AND name = ?')
    .get(userId, name)
  if (!row) return null
  return store.wrap(db, rowToSession(row))
}

function listForUser(db, userId) {
  return db
    .prepare(
      'SELECT ' +
        SELECT_COLUMNS +
        ' FROM sessions WHERE user_id = ? ORDER BY last_used DESC NULLS LAST, name DESC',
    )
    .all(userId)
    .map((row) => store.wrap(db, rowToSession(row)))
}

function list(db, limit = 500) {
  const bounded = Math.max(1, Math.min(Number(limit) || 500, 2000))
  return db
    .prepare('SELECT ' + SELECT_COLUMNS + ' FROM sessions ORDER BY updated_at DESC LIMIT ?')
    .all(bounded)
    .map((row) => store.wrap(db, rowToSession(row)))
}

function create(db, userId, fields = {}) {
  if (!userId) throw new Error('sessions.create requires a userId')
  const name = fields.name || new Date().toISOString().slice(0, 19).replace('T', ' ')
  const now = Date.now()
  const session = {
    userId,
    name,
    id: fields.id ?? null,
    parentId: fields.parentId ?? null,
    generation: normalizeGeneration(fields.generation),
    toolCalling: fields.toolCalling ?? true,
    vision: fields.vision ?? false,
    model: fields.model ?? null,
    todos: fields.todos ?? null,
    turnCount: fields.turnCount ?? 0,
    dynamicToolsHash: fields.dynamicToolsHash ?? null,
    mcpInjected: fields.mcpInjected ?? null,
    state: fields.state ?? 'idle',
    metadata: fields.metadata ?? {},
    lastUsed: fields.lastUsed ?? now,
    createdAt: fields.createdAt ?? now,
    updatedAt: now,
  }
  store.flush(db, session)
  return store.wrap(db, session)
}

// Rebase a session onto a newer compaction generation: forget the upstream
// chat pointer, stash the old id, and record the new generation. Shared by
// sessions.resolve and the per-request rebase in core/chat-router.js.
function rebase(session, generation) {
  const previousId = session.id || null
  const pendingIds = Array.isArray(session.metadata?.pendingPreviousConversationIds)
    ? session.metadata.pendingPreviousConversationIds.filter(
        (value) => typeof value === 'string' && value !== '',
      )
    : []
  if (previousId) pendingIds.push(previousId)
  session.generation = generation
  session.id = null
  session.parentId = null
  session.state = 'rebased'
  session.metadata = {
    ...(session.metadata || {}),
    pendingPreviousConversationIds: [...new Set(pendingIds)],
  }
}

function resolve(db, userId, name, options = {}) {
  if (!userId || !name) {
    return {
      userId: userId || null,
      name: name || null,
      id: null,
      parentId: null,
      generation: normalizeGeneration(options.generation),
      state: 'transient',
      metadata: {},
      persistent: false,
    }
  }

  const incoming = normalizeGeneration(options.generation)
  let session = get(db, userId, name)
  if (!session) {
    const created = create(db, userId, { name, generation: incoming })
    created.persistent = true
    return created
  }
  session.persistent = true

  if (incoming > session.generation) rebase(session, incoming)
  return session
}

function remove(db, userId, name) {
  store.cancel(keyFor(userId, name))
  return db.prepare('DELETE FROM sessions WHERE user_id = ? AND name = ?').run(userId, name).changes
}

function removeAllForUser(db, userId) {
  store.cancelWhere((key) => key.startsWith(userId + '\u0000'))
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes
}

module.exports = {
  BLOB_KEYS,
  COLUMN_MAP,
  create,
  rebase,
  flush: store.flush,
  flushAll: store.flushAll,
  flushNow: store.flushNow,
  get,
  list,
  listForUser,
  normalizeGeneration,
  remove,
  removeAllForUser,
  resolve,
  rowToSession,
}
