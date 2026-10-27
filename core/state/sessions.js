'use strict'

/**
 * Sessions: one row per (user, session name).
 *
 * Column names are snake_case; the JS object is camelCase. Persistence and the
 * recursive Proxy live in sqlite-pro; this module supplies the table
 * config and the session-specific domain functions. Writes (nested plain
 * objects/arrays included) are debounced 250 ms.
 *
 * Compaction: when a caller reports a higher generation than the row holds,
 * id and parentId are cleared and the old id is appended to
 * metadata.pendingPreviousConversationIds.
 */

const { createStore } = require('sqlite-pro')

const MAX_GENERATION = Number.MAX_SAFE_INTEGER

const keyFor = (userId, name) => userId + '\u0000' + name

const SCHEMA = {
  columns: {
    userId: 'text required ->users.id:cascade',
    name: 'text required',
    id: 'text',
    parentId: 'text',
    generation: 'integer required =0',
    toolCalling: 'boolean',
    vision: 'boolean',
    model: 'text',
    transport: 'text',
    turnCount: 'integer',
    dynamicToolsHash: 'text',
    state: 'text',
    lastTokenUsage: 'integer',
    lastUsed: 'integer',
    createdAt: 'integer',
    metadata: 'json',
    todos: 'json',
    mcpInjected: 'json',
    usageTotals: 'json',
    updatedAt: 'integer required',
  },
  primaryKey: 'userId+name',
  indexes: ['idx_sessions_user: userId,-lastUsed'],
}

const store = createStore({
  schema: SCHEMA,
  table: 'sessions',
  conflict: ['user_id', 'name'],
  keyOf: (session) => keyFor(session.userId, session.name),
  flushMs: 250,
  label: 'sessions',
  transientKeys: new Set(['persistent', 'provider', 'onCaptureChanged']),
  booleanKeys: new Set(['toolCalling', 'vision']),
  defaults: { metadata: () => ({}) },
  afterDecode: (session) => {
    session.generation = normalizeGeneration(session.generation)
  },
  beforeCreate: prepareSession,
})

function normalizeGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_GENERATION ? value : 0
}

// create() hook: name, generation, and the defaults a new session starts with.
function prepareSession(session) {
  if (!session.userId) throw new Error('sessions.create requires a userId')
  const now = Date.now()
  session.name = session.name || new Date().toISOString().slice(0, 19).replace('T', ' ')
  session.generation = normalizeGeneration(session.generation)
  if (session.toolCalling === undefined) session.toolCalling = true
  if (session.vision === undefined) session.vision = false
  if (session.turnCount === undefined) session.turnCount = 0
  if (session.state === undefined) session.state = 'idle'
  if (session.metadata === undefined) session.metadata = {}
  if (session.lastUsed === undefined) session.lastUsed = now
  for (const key of [
    'id',
    'parentId',
    'model',
    'transport',
    'todos',
    'dynamicToolsHash',
    'mcpInjected',
  ]) {
    if (session[key] === undefined) session[key] = null
  }
}

function list(db, limit = 500) {
  const bounded = Math.max(1, Math.min(Number(limit) || 500, 2000))
  const table = db.table('sessions')
  const rows = table.orderBy('updatedAt').reverse().limit(bounded).toArray()
  const total = table.count()
  return { rows, total, truncated: rows.length < total }
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
  const table = db.table('sessions')
  let session = table.get(userId, name)
  if (!session) {
    const created = table.add({ userId, name, generation: incoming })
    created.persistent = true
    return created
  }
  session.persistent = true

  if (incoming > session.generation) rebase(session, incoming)
  return session
}

module.exports = Object.assign(store, { rebase, list, normalizeGeneration, resolve })
