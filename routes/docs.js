const express = require('express')
const { readAsset } = require('../utils/bundle')

const router = express.Router()

router.get('/openapi.json', (req, res) => {
  try {
    res.type('application/json').send(readAsset('openapi.json', 'utf8'))
  } catch {
    res.status(500).json({ error: { message: 'openapi.json unavailable' } })
  }
})

router.get('/docs', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>ZeroKey API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' })
  </script>
</body>
</html>`)
})

module.exports = router
