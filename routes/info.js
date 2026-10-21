const express = require('express')
const registry = require('../providers/registry')

const router = express.Router()

let pkgVersion = 'unknown'
try {
  pkgVersion = require('../package.json').version
} catch {
  // Non-fatal: fall back to 'unknown' if package.json is unavailable.
}

// GET / - Root endpoint with API info
router.get('/', (req, res) => {
  res.json({
    name: 'ZeroKey API Server',
    version: pkgVersion,
    description: 'OpenAI-compatible AI proxy for DeepSeek, Claude, ChatGPT, Qwen & Inception',
    endpoints: {
      health: 'GET /health',
      models: 'GET /v1/models',
      chat_completions: 'POST /v1/chat/completions',
    },
    models: Object.keys(registry.getModels()),
  })
})

module.exports = router
