const express = require('express')
const { MODELS, MODEL_HASH } = require('../config/constants')
const { toOpenAIError } = require('../utils/errors')

function buildModelsRouter(preSelected) {
  const router = express.Router()

  const activeModel = MODEL_HASH[preSelected?.provider]?.models?.[preSelected?.session?.model]

  // GET /v1/models - List all supported models, with the active one flagged
  router.get('/', (req, res) => {
    res.json({
      object: 'list',
      data: Object.values(MODELS),
      activeModel,
    })
  })

  // GET /v1/models/:model - Get a specific model (from the full registry)
  router.get('/:model', (req, res) => {
    const model = MODELS[req.params.model]
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

  return router
}

module.exports = buildModelsRouter
