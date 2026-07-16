const express = require('express')

function buildHealthRouter(preSelected) {
  const router = express.Router()

  // GET /health - Health check endpoint
  router.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      provider: preSelected?.provider || null,
      model: preSelected?.session?.model || null,
      username: preSelected?.user || null,
    })
  })

  return router
}

module.exports = buildHealthRouter
