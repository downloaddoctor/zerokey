const express = require('express')
const fs = require('fs')
const path = require('path')

const router = express.Router()

const openapiPath = path.join(__dirname, '..', 'openapi.json')

router.get('/openapi.json', (req, res) => {
  fs.readFile(openapiPath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: { message: 'openapi.json unavailable' } })
    res.type('application/json').send(data)
  })
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
