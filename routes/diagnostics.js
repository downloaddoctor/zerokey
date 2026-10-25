'use strict'

const express = require('express')
const diagnostics = require('../utils/diagnostics')

/**
 * GET /v1/diagnostics — bounded, redacted, loopback-only summary.
 *
 * Express binds to 127.0.0.1 and app.js rejects non-loopback Host headers.
 * There is no bearer check (the proxy has no auth). This router is a data
 * projector only.
 */
function buildDiagnosticsRouter(context) {
  const router = express.Router()
  const startedAt = context.startedAt || Date.now()

  router.get('/', (req, res) => {
    const payload = diagnostics.diagnosePayload({
      host: context.host,
      port: context.port,
      startedAt,
      db: context.db || null,
      providerStatus: context.providerStatus || null,
      queue: context.queue || null,
    })
    res.json(payload)
  })

  return router
}

module.exports = buildDiagnosticsRouter
