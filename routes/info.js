const express = require('express')
const { MODELS } = require('../config/constants')

const router = express.Router()

// GET / - Root endpoint with API info
router.get('/', (req, res) => {
  res.json({
    name: 'ZeroKey API Server',
    version: '1.0.0',
    description: 'OpenAI-compatible AI proxy for DeepSeek, Claude & ChatGPT',
    endpoints: {
      health: 'GET /health',
      models: 'GET /v1/models',
      chat_completions: 'POST /v1/chat/completions',
    },
    models: Object.keys(MODELS),
  })
})

module.exports = router
