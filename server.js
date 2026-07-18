require('./utils/logger')

const fs = require('fs')
const express = require('express')
const infoRouter = require('./routes/info')
const buildModelsRouter = require('./routes/models')
const buildHealthRouter = require('./routes/health')
const buildRouter = require('./core/chat-router')

const { CONFIG } = require('./config/constants')
const { SessionSelector } = require('./core/session-selector')
const { toOpenAIError } = require('./utils/errors')
const { findPort } = require('./utils/find-port')
const { syncIdeConfig } = require('./utils/sync-ide-config')

const app = express()

app.use(express.json({ limit: '50mb' }))

app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    const bodySize = req.body?.messages?.length ? `${req.body.messages.length} msgs` : '-'
    console.debug(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${duration}ms) | IDE: ${req.ide || '?'}\n`,
    )
  })
  next()
})

const VALID_IDES = new Set(['vscode', 'terax', 'opencode'])

app.use((req, res, next) => {
  const authHeader = req.headers.authorization || ''
  const rawIde = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim().toLowerCase()
    : 'vscode'
  req.ide = VALID_IDES.has(rawIde) ? rawIde : 'vscode'
  next()
})

app.use('/', infoRouter)
;(async () => {
  const selector = new SessionSelector()
  const preSelected = await selector.select(true)

  if (!preSelected) {
    console.error('No session selected. Exiting.')
    process.exit(0)
  }

  const _tags = [
    preSelected.user,
    preSelected.provider,
    preSelected.sessionName,
    preSelected.session.model,
  ].join(' · ')
  console.info(`\n[Server] ${_tags}\n         ${preSelected.sessionTags}`)

  const port = await findPort(CONFIG.PORT)

  app.use('/', buildHealthRouter(preSelected))
  app.use('/v1/models', buildModelsRouter(preSelected))

  await syncIdeConfig(preSelected, port)

  try {
    const router = await buildRouter(preSelected)
    app.use('/v1/chat/completions', router)
  } catch (error) {
    console.error('Failed to build initial router:', error)
    process.exit(1)
  }

  app.use((err, req, res, _next) => {
    console.error('[Server] Unhandled error:', err.message || err)
    const openaiErr = toOpenAIError(err, preSelected.provider)
    const status = openaiErr.error?.status || err.statusCode || err.status || 500
    try {
      const detail = [
        `[${new Date().toISOString()}]`,
        `${req.method} ${req.originalUrl}`,
        `Status: ${status}`,
        `Message: ${err.message || err}`,
        err.stack || '',
        `Body: ${JSON.stringify(req.body, null, 2)}`,
      ].join('\n')
      fs.appendFileSync(`temp/errors.txt`, detail + '\n\n---\n\n')
    } catch {}
    if (!res.headersSent) res.status(status).json(openaiErr)
    else res.end()
  })

  const server = app.listen(port, () => {
    console.success(`\n√ ZeroKey running on http://localhost:${port}`)
    console.log('Endpoints:')
    console.log(`  GET  http://localhost:${port}/`)
    console.log(`  GET  http://localhost:${port}/health`)
    console.log(`  GET  http://localhost:${port}/v1/models`)
    console.log(`  POST http://localhost:${port}/v1/chat/completions`)
    console.log(`\n  IDE from Authorization: Bearer <vscode|terax|opencode> (default: vscode)\n`)
  })

  const shutdown = (signal) => {
    console.warn(`\n[Server] ${signal} received — shutting down...`)
    selector.flush()
    server.close(() => {
      console.success('[Server] Closed.')
      process.exit(0)
    })
    setTimeout(() => {
      console.error('[Server] Forced shutdown after timeout.')
      process.exit(1)
    }, 5000)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGHUP', () => shutdown('SIGHUP'))
  process.on('exit', () => selector.flush())
})()
