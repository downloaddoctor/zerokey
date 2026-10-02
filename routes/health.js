const express = require('express')

const registry = require('../providers/registry')

function buildHealthRouter(preSelected) {
  const router = express.Router()

  // Per-provider prompt limit, in characters (not tokens). Clients that
  // auto-compact need this to configure their threshold correctly.
  const promptLimit = registry.get(preSelected?.provider)?.promptLimit ?? null

  // GET /health - Health check endpoint
  router.get('/health', (req, res) => {
    const session = preSelected?.session || null
    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      username: preSelected?.user || null,
      provider: preSelected?.provider || null,
      model: session?.model || null,
      session: session
        ? {
            name: preSelected.sessionName,
            // The trap: pipeline.js does `session.toolCalling ?? false`.
            // A false here means the proxy will run in Raw Mode and no tool
            // call will ever reach the IDE — silently. Surface it.
            toolCalling: session.toolCalling ?? false,
            vision: session.vision ?? false,
          }
        : null,
      sessionTags: preSelected?.sessionTags || null,
      promptLimit: promptLimit
        ? { chars: promptLimit, unit: 'characters', approxTokens: Math.round(promptLimit / 4) }
        : null,
      usageMode: 'real-when-available',
    })
  })

  return router
}

module.exports = buildHealthRouter
