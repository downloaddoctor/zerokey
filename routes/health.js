'use strict'

const express = require('express')
const registry = require('../providers/registry')
const db = require('../core/state/db')
const sessions = require('../core/state/sessions')

function buildHealthRouter(preSelected, context = {}) {
  const router = express.Router()

  const providerDef = registry.get(preSelected?.provider)
  const promptLimit = providerDef?.promptLimit ?? null
  const reinjectEvery = providerDef?.reinjectEvery ?? 0
  const store = context.db || null

  router.get('/health', (req, res) => {
    const session = preSelected?.session || null

    let persistence = null
    if (store) {
      try {
        const count = store.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
        const importDone = db.getMeta(store, 'legacy_import_done')
        persistence = {
          schema_version: db.getMeta(store, 'schema_version'),
          sessions: count,
          legacy_import_done: Boolean(importDone),
        }
      } catch (error) {
        persistence = { error: error.message }
      }
    }

    let sessionRow = null
    if (store && preSelected?.sessionName) {
      try {
        const row = sessions.get(store, preSelected.provider, preSelected.sessionName)
        if (row) {
          sessionRow = {
            upstream_conversation_id: row.upstreamConversationId,
            upstream_parent_message_id: row.upstreamParentMessageId,
            state: row.state,
            updated_at: row.updatedAt,
          }
        }
      } catch {
        sessionRow = null
      }
    }

    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      pid: process.pid,
      username: preSelected?.user || null,
      provider: preSelected?.provider || null,
      model: session?.model || null,
      session: session
        ? {
            name: preSelected.sessionName,
            toolCalling: session.toolCalling ?? false,
            vision: session.vision ?? false,
            turnCount: session.turnCount ?? 0,
          }
        : null,
      sessionRow,
      persistence,
      sessionTags: preSelected?.sessionTags || null,
      promptLimit: promptLimit
        ? { chars: promptLimit, unit: 'characters', approxTokens: Math.round(promptLimit / 4) }
        : null,
      reinjectEvery,
      usageMode: 'real-when-available',
    })
  })

  return router
}

module.exports = buildHealthRouter
