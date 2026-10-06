'use strict'

/**
 * Sessions: one row per (user, session name).
 *
 * Column names are snake_case; the JS object is camelCase. The proxy in this
 * module is the boundary. Writes are debounced 50 ms; nested writes are not
 * intercepted, so reassign a field to persist a change.
 *
 * Compaction: when a caller reports a higher generation than the row holds,
 * id and parentId are cleared and the old id is appended to
 * metadata.pendingPreviousConversationIds.
 */

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
  lastUsed: 'last_used',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
}

const BLOB_KEYS = new Set(['todos', 'metadata', 'mcpInjected'])
const FLUSH_MS = 50
const MAX_GENERATION = Number.MAX_SAFE_INTEGER
const SELECT_COLUMNS =
  'user_id, name, id, parent_id, generation, tool_calling, vision, model, ' +
  'todos_json, turn_count, dynamic_tools_hash, mcp_injected_json, state, metadata_json, ' +
  'last_used, created_at, state_json, updated_at'

const pending = new Map()

function parseBlob(value, fallback) {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch (caughtErr) {
    console.error('JSON.parse() failed:', caughtErr)
    return fallback
  }
}

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
    lastUsed: row.last_used ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at,
  }
  for (const [key, value] of Object.entries(state)) {
    if (!(key in session)) session[key] = value
  }
  return session
}

function columnProjection(session) {
  const columns = {}
  const state = {}
  for (const [key, value] of Object.entries(session)) {
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

function flush(db, session) {
  const { columns, state } = columnProjection(session)
  columns.state_json = state
  columns.updated_at = Date.now()
  session.updatedAt = columns.updated_at

  const names = Object.keys(columns)
  const placeholders = names.map(() => '?').join(', ')
  const updates = names
    .filter((n) => n !== 'user_id' && n !== 'name')
    .map((n) => n + ' = excluded.' + n)
    .join(', ')
  db.prepare(
    'INSERT INTO sessions (' +
      names.join(', ') +
      ') VALUES (' +
      placeholders +
      ') ON CONFLICT(user_id, name) DO UPDATE SET ' +
      updates,
  ).run(...names.map((n) => columns[n]))
}

function schedule(db, session) {
  const key = session.userId + '\u0000' + session.name
  if (pending.has(key)) return
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key)
      try {
        flush(db, session)
      } catch (error) {
        console.error('flush() failed:', error)
        // A flush scheduled just before the caller closed the database is
        // expected in short-lived processes (tests). Any other error is
        // reported once.
        const message = error && error.message ? error.message : String(error)
        if (!/database is not open/i.test(message)) {
          console.error('sessions flush failed: ' + message)
        }
      }
    }, FLUSH_MS),
  )
}

function wrap(db, session) {
  return new Proxy(session, {
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

function get(db, userId, name) {
  const row = db
    .prepare('SELECT ' + SELECT_COLUMNS + ' FROM sessions WHERE user_id = ? AND name = ?')
    .get(userId, name)
  if (!row) return null
  return wrap(db, rowToSession(row))
}

function listForUser(db, userId) {
  return db
    .prepare(
      'SELECT ' +
        SELECT_COLUMNS +
        ' FROM sessions WHERE user_id = ? ORDER BY last_used DESC NULLS LAST, name DESC',
    )
    .all(userId)
    .map((row) => wrap(db, rowToSession(row)))
}

function list(db, limit = 500) {
  const bounded = Math.max(1, Math.min(Number(limit) || 500, 2000))
  return db
    .prepare('SELECT ' + SELECT_COLUMNS + ' FROM sessions ORDER BY updated_at DESC LIMIT ?')
    .all(bounded)
    .map(rowToSession)
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
  flush(db, session)
  return wrap(db, session)
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

  if (incoming > session.generation) {
    const previousId = session.id || null
    const pendingIds = Array.isArray(session.metadata.pendingPreviousConversationIds)
      ? session.metadata.pendingPreviousConversationIds.filter(
          (value) => typeof value === 'string' && value !== '',
        )
      : []
    if (previousId) pendingIds.push(previousId)
    session.generation = incoming
    session.id = null
    session.parentId = null
    session.state = 'rebased'
    session.metadata = {
      ...(session.metadata || {}),
      pendingPreviousConversationIds: [...new Set(pendingIds)],
    }
  }
  return session
}

function remove(db, userId, name) {
  const key = userId + '\u0000' + name
  if (pending.has(key)) {
    clearTimeout(pending.get(key))
    pending.delete(key)
  }
  return db.prepare('DELETE FROM sessions WHERE user_id = ? AND name = ?').run(userId, name).changes
}

function removeAllForUser(db, userId) {
  for (const key of [...pending.keys()]) {
    if (key.startsWith(userId + '\u0000')) {
      clearTimeout(pending.get(key))
      pending.delete(key)
    }
  }
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes
}

function flushNow(db, session) {
  const key = session.userId + '\u0000' + session.name
  if (pending.has(key)) {
    clearTimeout(pending.get(key))
    pending.delete(key)
  }
  flush(db, session)
}

module.exports = {
  BLOB_KEYS,
  COLUMN_MAP,
  create,
  flush,
  flushNow,
  get,
  list,
  listForUser,
  normalizeGeneration,
  remove,
  removeAllForUser,
  resolve,
  rowToSession,
}
