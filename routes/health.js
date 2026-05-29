const express = require('express')
const { MODELS } = require('../config/constants')

const router = express.Router()

// GET /health - Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  })
})

// GET / - Root endpoint with API info
router.get('/', (req, res) => {
  res.json({
    name: 'ZeroKey API Server',
    version: '1.0.0',
    description: 'OpenAI-compatible AI proxy for DeepSeek & ChatGPT',
    endpoints: {
      models: 'GET /v1/models',
      chat_completions: 'POST /v1/chat/completions',
      health: 'GET /health',
    },
    models: Object.keys(MODELS),
  })
})

module.exports = router
