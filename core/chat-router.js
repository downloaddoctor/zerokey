'use strict'

/**
 * Provider seam with persistent session state.
 *
 * Session resolution reads (provider, sessionKey) from the sessions table.
 * A higher compaction generation on the incoming request rebinds the upstream
 * conversation (see core/state/sessions.js).
 *
 * Contract:
 *   - caller passes `sessionContext` = { db, sessionKey, generation }
 *   - without a db or sessionKey, a transient in-memory session is used
 *   - after the response finishes, sessions.save() persists whatever the
 *     stream handler wrote back (chatSessionId, parentMessageId)
 */

const registry = require('../providers/registry')
const sessions = require('./state/sessions')
const log = require('../utils/log')

function seedSession(selected, sessionContext) {
  const provider = selected.provider
  const sessionKey = sessionContext?.sessionKey || selected.sessionName || null
  const generation = sessionContext?.generation || 0

  if (!sessionContext?.db || !sessionKey) {
    return {
      provider,
      session: {
        ...(selected.session || {}),
        provider,
        id: null,
        generation,
        persistent: false,
      },
      row: null,
      sessionKey: null,
      db: null,
    }
  }

  const row = sessions.resolve(sessionContext.db, provider, sessionKey, { generation })
  const session = {
    ...(selected.session || {}),
    provider: row.provider,
    id: row.id,
    generation: row.generation,
    chatSessionId: row.upstreamConversationId || selected.session?.chatSessionId || null,
    parentMessageId: row.upstreamParentMessageId || selected.session?.parentMessageId || null,
    metadata: row.metadata || {},
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
        generation: seed.row.generation,
        metadata: seed.row.metadata || {},
      },
      { state: session.chatSessionId ? 'idle' : 'unbound' },
    )
  } catch (error) {
    log.warn('Session persistence failed: ' + (error.message || error))
  }
}

async function buildRouter(selected, sessionContext) {
  const provider = registry.get(selected.provider)
  if (!provider) throw new Error('Unknown provider: ' + selected.provider)

  const seed = seedSession(selected, sessionContext)
  const router = await provider.buildRouter(selected.parsedFetch, seed.session, selected.userData)

  return (req, res, next) => {
    // Read the generation from headers so a mid-session compaction on the
    // client is reflected in the session row before the provider sees it.
    const headers = require('../utils/headers').read(req.headers)
    if (seed.db && seed.row && headers.generation > seed.row.generation) {
      const reread = sessions.resolve(seed.db, seed.provider, seed.row.id, {
        generation: headers.generation,
      })
      if (reread) {
        seed.row = reread
        seed.session.generation = reread.generation
        seed.session.chatSessionId = reread.upstreamConversationId
        seed.session.parentMessageId = reread.upstreamParentMessageId
        seed.session.metadata = reread.metadata
      }
    }

    res.on('finish', () => persistAfterTurn(seed, seed.session))
    res.on('close', () => {
      if (!res.writableFinished) persistAfterTurn(seed, seed.session)
    })
    return router(req, res, next)
  }
}

module.exports = buildRouter
