'use strict'

/**
 * Provider seam with persistent session state.
 *
 * The selector already resolved (userId, sessionName) and passes its
 * Proxy-wrapped row as `selected.session`; this module adopts that single
 * instance (no re-resolve, no copy) so every router mutation persists. A
 * higher compaction generation on the incoming request rebases it in place
 * (see core/state/sessions.js).
 *
 * Contract:
 *   - caller passes `sessionContext` = { db, userId, sessionName }
 *   - without a db or userId, a transient in-memory session is used
 *   - after the response finishes, sessions.flushNow guarantees the write
 */

const registry = require('../providers/registry')
const sessions = require('./state/sessions')
const users = require('./state/users')
const headers = require('../utils/headers')

function adoptSession(selected, sessionContext) {
  const provider = selected.provider
  const userId = sessionContext?.userId || null
  const sessionName = sessionContext?.sessionName || selected.sessionName || null
  const persistent = Boolean(sessionContext?.db && userId && sessionName && selected.session)

  if (!persistent) {
    return {
      session: { ...(selected.session || {}), provider, id: null, persistent: false },
      userId: null,
      db: null,
    }
  }

  const session = selected.session
  session.provider = provider
  session.userId = userId
  session.name = sessionName
  session._usageTotals = session.usageTotals
  session.persistent = true
  return { session, userId, db: sessionContext.db }
}

function persistAfterTurn(db, session) {
  if (!db || !session || !session.persistent) return
  try {
    session.lastUsed = Date.now()
    session.state = session.id ? 'idle' : 'unbound'
    session.usageTotals = session._usageTotals ?? session.usageTotals
    // Guarantee the write: the Proxy debounce may not have fired yet.
    sessions.flushNow(db, session)
  } catch (error) {
    console.error('sessions flush failed:', error)
    console.warn('Session persistence failed: ' + (error.message || error))
  }
}

async function buildRouter(selected, sessionContext) {
  const provider = registry.get(selected.provider)
  if (!provider) throw new Error('Unknown provider: ' + selected.provider)

  const { session, userId, db } = adoptSession(selected, sessionContext)

  // Wire the credential callback so any mutation of the in-memory capture is
  // persisted to the user row. The provider client sees only a callback.
  if (userId && db) {
    session.onCaptureChanged = (nextCapture) => {
      try {
        const user = users.getById(db, userId)
        if (user) user.parsedFetch = nextCapture
      } catch (error) {
        console.error('users.getById() failed for id ' + userId + ':', error)
        console.warn('Credential persistence failed: ' + (error.message || error))
      }
    }
  }

  const router = await provider.buildRouter(selected.parsedFetch, session, selected.userData)

  return (req, res, next) => {
    const read = headers.read(req.headers)
    if (db && session.persistent && read.generation > session.generation) {
      sessions.rebase(session, read.generation)
    }

    res.on('finish', () => persistAfterTurn(db, session))
    res.on('close', () => {
      if (!res.writableFinished) persistAfterTurn(db, session)
    })
    return router(req, res, next)
  }
}

module.exports = buildRouter
