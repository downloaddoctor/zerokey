'use strict'

const express = require('express')
const registry = require('../providers/registry')
const db = require('../core/state/db')

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
        const count = store.table('sessions').count()
        persistence = {
          schema_version: db.getMeta(store, 'schema_version'),
          sessions: count,
          pending_writes: store.table('users').pending() + store.table('sessions').pending(),
        }
      } catch (error) {
        console.error('persistence stats failed:', error)
        persistence = { error: error.message }
      }
    }

    let sessionRow = null
    const userId = preSelected?.userData?.id || preSelected?.session?.userId || null
    if (store && userId && preSelected?.sessionName) {
      try {
        const row = store.table('sessions').get(userId, preSelected.sessionName)
        if (row) {
          sessionRow = {
            upstream_conversation_id: row.id,
            upstream_parent_message_id: row.parentId,
            state: row.state,
            transport: row.transport,
            updated_at: row.updatedAt,
          }
        }
      } catch (caughtErr) {
        console.error('sessions table get() failed:', caughtErr)
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
