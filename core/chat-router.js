'use strict'

/**
 * Provider seam with persistent session state.
 *
 * Session resolution reads (userId, sessionName) from the sessions table.
 * A higher compaction generation on the incoming request rebinds the
 * upstream conversation (see core/state/sessions.js).
 *
 * Contract:
 *   - caller passes `sessionContext` = { db, userId, sessionName, generation }
 *   - without a db or userId, a transient in-memory session is used
 *   - after the response finishes, sessions.flush persists whatever the
 *     stream handler wrote back (id, parentId)
 */

const registry = require('../providers/registry')
const sessions = require('./state/sessions')
const users = require('./state/users')
const headers = require('../utils/headers')

function seedSession(selected, sessionContext) {
  const provider = selected.provider
  const userId = sessionContext?.userId || null
  const sessionName = sessionContext?.sessionName || selected.sessionName || null
  const generation = sessionContext?.generation || 0

  if (!sessionContext?.db || !userId || !sessionName) {
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
      userId: null,
      sessionName: null,
      db: null,
    }
  }

  const row = sessions.resolve(sessionContext.db, userId, sessionName, { generation })
  const session = {
    ...(selected.session || {}),
    provider,
    userId,
    name: sessionName,
    id: row.id || selected.session?.id || null,
    parentId: row.parentId || selected.session?.parentId || null,
    generation: row.generation,
    toolCalling: row.toolCalling ?? selected.session?.toolCalling ?? true,
    vision: row.vision ?? selected.session?.vision ?? false,
    model: row.model ?? selected.session?.model ?? null,
    todos: row.todos ?? selected.session?.todos ?? null,
    turnCount: row.turnCount ?? selected.session?.turnCount ?? 0,
    dynamicToolsHash: row.dynamicToolsHash ?? selected.session?.dynamicToolsHash ?? null,
    mcpInjected: row.mcpInjected ?? selected.session?.mcpInjected ?? false,
    metadata: row.metadata || {},
    persistent: true,
  }
  return { provider, session, row, userId, sessionName, db: sessionContext.db }
}

function persistAfterTurn(seed, session) {
  if (!seed.db || !seed.row) return
  try {
    seed.row.id = session.id || null
    seed.row.parentId = session.parentId || null
    seed.row.toolCalling = session.toolCalling ?? seed.row.toolCalling
    seed.row.vision = session.vision ?? seed.row.vision
    seed.row.model = session.model ?? seed.row.model
    seed.row.todos = session.todos ?? seed.row.todos
    seed.row.turnCount = session.turnCount ?? seed.row.turnCount
    seed.row.dynamicToolsHash = session.dynamicToolsHash ?? seed.row.dynamicToolsHash
    seed.row.mcpInjected = session.mcpInjected ?? seed.row.mcpInjected
    seed.row.lastUsed = Date.now()
    seed.row.state = session.id ? 'idle' : 'unbound'
    seed.session.lastUsed = seed.row.lastUsed
  } catch (error) {
    console.error('sessions flush failed:', error)
    console.warn('Session persistence failed: ' + (error.message || error))
  }
}

async function buildRouter(selected, sessionContext) {
  const provider = registry.get(selected.provider)
  if (!provider) throw new Error('Unknown provider: ' + selected.provider)

  const seed = seedSession(selected, sessionContext)

  // Wire the credential callback so any mutation of the in-memory capture is
  // persisted to the user row. The provider client sees only a callback.
  const userId = seed.userId
  const db = seed.db
  if (userId && db) {
    seed.session.onCaptureChanged = (nextCapture) => {
      try {
        const user = users.getById(db, userId)
        if (user) user.parsedFetch = nextCapture
      } catch (error) {
        console.error('users.getById() failed for id ' + userId + ':', error)
        console.warn('Credential persistence failed: ' + (error.message || error))
      }
    }
  }

  const router = await provider.buildRouter(selected.parsedFetch, seed.session, selected.userData)

  return (req, res, next) => {
    const read = headers.read(req.headers)
    if (seed.db && seed.row && read.generation > seed.row.generation) {
      const reread = sessions.resolve(seed.db, seed.userId, seed.sessionName, {
        generation: read.generation,
      })
      if (reread) {
        seed.row = reread
        seed.session.generation = reread.generation
        seed.session.id = reread.id
        seed.session.parentId = reread.parentId
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
