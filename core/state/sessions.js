'use strict'

/**
 * Persistent mapping:  (provider, session id)  ->  upstream conversation.
 *
 * Only technical IDs, state, and timestamps are stored. Prompt or response
 * content never touches this table.
 *
 * Compaction generations are handled here: when the caller reports a higher
 * generation than the row holds, the upstream conversation binding is broken
 * (upstream_* cleared) and the old conversation ID is appended to
 * metadata.pendingPreviousConversationIds so the next successful turn can
 * retire it after a fresh one succeeds.
 */

const VALID_ID = /^[A-Za-z0-9._:-]{1,200}$/
const MAX_GENERATION = Number.MAX_SAFE_INTEGER

function normalizeId(value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (!VALID_ID.test(id)) return null
  if (id === '__proto__' || id === 'prototype' || id === 'constructor') return null
  return id
}

function normalizeProvider(value) {
  if (typeof value !== 'string') return null
  const provider = value.trim().toLowerCase()
  if (!provider || provider.length > 64) return null
  return provider
}

function normalizeGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_GENERATION ? value : 0
}

function parseMetadata(value) {
  if (typeof value !== 'string' || value === '') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function rowToSession(row) {
  if (!row) return null
  return {
    provider: row.provider,
    id: row.session_id,
    upstreamConversationId: row.upstream_conversation_id || null,
    upstreamParentMessageId: row.upstream_parent_message_id || null,
    generation: normalizeGeneration(row.compaction_generation),
    state: row.state || 'idle',
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function get(db, provider, sessionId) {
  const providerName = normalizeProvider(provider)
  const id = normalizeId(sessionId)
  if (!providerName || !id) return null
  return rowToSession(
    db
      .prepare(
        'SELECT provider, session_id, upstream_conversation_id, ' +
          'upstream_parent_message_id, compaction_generation, state, ' +
          'metadata_json, created_at, updated_at ' +
          'FROM sessions WHERE provider = ? AND session_id = ?',
      )
      .get(providerName, id),
  )
}

function save(db, session, options = {}) {
  const provider = normalizeProvider(session && session.provider)
  const id = normalizeId(session && session.id)
  if (!provider || !id) return session

  const now = Date.now()
  const state =
    typeof options.state === 'string'
      ? options.state
      : typeof session.state === 'string'
        ? session.state
        : 'idle'
  const generation = normalizeGeneration(session.generation)
  const metadata =
    session.metadata && typeof session.metadata === 'object' ? { ...session.metadata } : {}
  const metadataJson = Object.keys(metadata).length === 0 ? null : JSON.stringify(metadata)

  db.prepare(
    'INSERT INTO sessions (' +
      'provider, session_id, upstream_conversation_id, upstream_parent_message_id, ' +
      'compaction_generation, state, metadata_json, created_at, updated_at' +
      ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(provider, session_id) DO UPDATE SET ' +
      'upstream_conversation_id = excluded.upstream_conversation_id, ' +
      'upstream_parent_message_id = excluded.upstream_parent_message_id, ' +
      'compaction_generation = excluded.compaction_generation, ' +
      'state = excluded.state, ' +
      'metadata_json = excluded.metadata_json, ' +
      'updated_at = excluded.updated_at',
  ).run(
    provider,
    id,
    session.upstreamConversationId || null,
    session.upstreamParentMessageId || null,
    generation,
    state,
    metadataJson,
    Number.isInteger(session.createdAt) ? session.createdAt : now,
    now,
  )

  session.provider = provider
  session.state = state
  session.generation = generation
  session.metadata = metadata
  session.createdAt = Number.isInteger(session.createdAt) ? session.createdAt : now
  session.updatedAt = now
  return session
}

/**
 * Resolve the persistent session for (provider, id). When `options.generation`
 * is higher than the row's, the upstream conversation is rebound: upstream_*
 * are cleared, the old conversation ID is appended to
 * metadata.pendingPreviousConversationIds, and state becomes 'rebased'.
 *
 * @param {object} db
 * @param {string} providerValue
 * @param {string} sessionIdValue
 * @param {{ generation?: number }} [options]
 */
function resolve(db, providerValue, sessionIdValue, options = {}) {
  const provider = normalizeProvider(providerValue)
  const id = normalizeId(sessionIdValue)
  const incoming = normalizeGeneration(options.generation)

  if (!provider || !id) {
    return {
      provider: provider || null,
      id: null,
      upstreamConversationId: null,
      upstreamParentMessageId: null,
      generation: incoming,
      state: 'transient',
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      persistent: false,
    }
  }

  let session = get(db, provider, id)
  if (!session) {
    session = {
      provider,
      id,
      upstreamConversationId: null,
      upstreamParentMessageId: null,
      generation: incoming,
      state: 'idle',
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      persistent: true,
    }
    return save(db, session)
  }
  session.persistent = true

  if (incoming > session.generation) {
    // Bind the incoming generation even if it is safe-integer max, so long as
    // it is strictly higher than what is on disk.
    const previousConversationId = session.upstreamConversationId || null
    const pending = Array.isArray(session.metadata.pendingPreviousConversationIds)
      ? session.metadata.pendingPreviousConversationIds.filter(
          (value) => typeof value === 'string' && value !== '',
        )
      : []
    if (previousConversationId) pending.push(previousConversationId)

    session.generation = incoming
    session.upstreamConversationId = null
    session.upstreamParentMessageId = null
    session.state = 'rebased'
    session.metadata = {
      ...(session.metadata || {}),
      pendingPreviousConversationIds: [...new Set(pending)],
    }
    save(db, session)
  }

  return session
}

function resetUpstream(db, providerValue, sessionIdValue) {
  const provider = normalizeProvider(providerValue)
  const id = normalizeId(sessionIdValue)
  if (!provider || !id) return null

  const current = get(db, provider, id)
  if (!current) return null

  const now = Date.now()
  db.prepare(
    'UPDATE sessions SET upstream_conversation_id = NULL, ' +
      'upstream_parent_message_id = NULL, state = ?, updated_at = ? ' +
      'WHERE provider = ? AND session_id = ?',
  ).run('rebased', now, provider, id)
  current.upstreamConversationId = null
  current.upstreamParentMessageId = null
  current.state = 'rebased'
  current.updatedAt = now
  return current
}

function list(db, limit = 100) {
  const bounded = Math.max(1, Math.min(Number(limit) || 100, 500))
  return db
    .prepare(
      'SELECT provider, session_id, upstream_conversation_id, ' +
        'upstream_parent_message_id, compaction_generation, state, ' +
        'metadata_json, created_at, updated_at ' +
        'FROM sessions ORDER BY updated_at DESC LIMIT ?',
    )
    .all(bounded)
    .map(rowToSession)
}

function remove(db, providerValue, sessionIdValue) {
  const provider = normalizeProvider(providerValue)
  const id = normalizeId(sessionIdValue)
  if (!provider || !id) return 0
  return db.prepare('DELETE FROM sessions WHERE provider = ? AND session_id = ?').run(provider, id)
    .changes
}

module.exports = {
  get,
  list,
  normalizeGeneration,
  normalizeId,
  normalizeProvider,
  remove,
  resetUpstream,
  resolve,
  save,
}
