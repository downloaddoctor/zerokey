const express = require('express')
const registry = require('../providers/registry')

const router = express.Router()

// GET / - Root endpoint with API info
router.get('/', (req, res) => {
  res.json({
    name: 'ZeroKey API Server',
    version: '1.0.0',
    description: 'OpenAI-compatible AI proxy for DeepSeek, Claude, ChatGPT & Qwen',
    endpoints: {
      health: 'GET /health',
      models: 'GET /v1/models',
      chat_completions: 'POST /v1/chat/completions',
    },
    models: Object.keys(registry.getModels()),
  })
})

module.exports = router
