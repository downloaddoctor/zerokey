const express = require('express')
const { MODELS, MODEL_ALIASES } = require('../config/constants')
const { toOpenAIError } = require('../utils/errors')

const router = express.Router()

// GET /v1/models - List available models
router.get('/', (req, res) => {
  res.json({
    object: 'list',
    data: Object.values(MODELS),
  })
})

// GET /v1/models/:model - Get specific model
router.get('/:model', (req, res) => {
  const resolved = MODEL_ALIASES[req.params.model]
  const model = MODELS[resolved]
  if (model) return res.json(model)

  res
    .status(404)
    .json(
      toOpenAIError(
        404,
        `Model '${req.params.model}' not found`,
        'invalid_request_error',
        'model_not_found',
      ),
    )
})

module.exports = router
