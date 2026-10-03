'use strict'

/**
 * Provider seam with persistent session state.
 *
 * The pipeline still receives `parsedFetch` (the browser capture), a live
 * session object, and the user record. The difference from before is that
 * `session` is now derived from the SQLite row keyed by `(provider, session id)`
 * rather than by whatever the selector happened to have in memory.
 *
 * Contract:
 *   - the caller passes a `sessionContext` = { db, sessionKey }
 *   - if db or sessionKey is missing, a transient in-memory session is used
 *     (same behaviour as before this batch) and nothing is persisted
 *   - if the row exists, its upstream IDs seed the in-memory session
 *   - after the provider streams a response, `sessions.save()` is called once
 *     with whatever the stream handler wrote back (chatSessionId,
 *     parentMessageId, state)
 */

const registry = require('../providers/registry')
const sessions = require('./state/sessions')
const log = require('../utils/log')

function seedSession(selected, sessionContext) {
  const provider = selected.provider
  const sessionKey = sessionContext?.sessionKey || selected.sessionName || null

  if (!sessionContext?.db || !sessionKey) {
    return {
      provider,
      session: {
        ...(selected.session || {}),
        provider,
        id: null,
        persistent: false,
      },
      row: null,
      sessionKey: null,
      db: null,
    }
  }

  const row = sessions.resolve(sessionContext.db, provider, sessionKey)
  const session = {
    ...(selected.session || {}),
    provider: row.provider,
    id: row.id,
    chatSessionId: row.upstreamConversationId || selected.session?.chatSessionId || null,
    parentMessageId: row.upstreamParentMessageId || selected.session?.parentMessageId || null,
    persistent: true,
  }
  return { provider, session, row, sessionKey, db: sessionContext.db }
}

function persistAfterTurn(seed, session) {
  if (!seed.db || !seed.row) return
  try {
    sessions.save(
      seed.db,
      {
        provider: seed.provider,
        id: seed.row.id,
        upstreamConversationId: session.chatSessionId || null,
        upstreamParentMessageId: session.parentMessageId || null,
        metadata: seed.row.metadata || {},
      },
      { state: session.chatSessionId ? 'idle' : 'unbound' },
    )
  } catch (error) {
    // Persistence is best-effort for interactive chat: a transient SQLite
    // failure must not fail a turn that already reached the user.
    log.warn('Session persistence failed: ' + (error.message || error))
  }
}

async function buildRouter(selected, sessionContext) {
  const provider = registry.get(selected.provider)
  if (!provider) throw new Error(`Unknown provider: ${selected.provider}`)

  const seed = seedSession(selected, sessionContext)
  const router = await provider.buildRouter(selected.parsedFetch, seed.session, selected.userData)

  // Wrap the router so the session row reflects what the stream handler wrote.
  return (req, res, next) => {
    res.on('finish', () => persistAfterTurn(seed, seed.session))
    res.on('close', () => {
      if (!res.writableFinished) persistAfterTurn(seed, seed.session)
    })
    return router(req, res, next)
  }
}

module.exports = buildRouter
