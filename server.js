const express = require('express')

const infoRouter = require('./routes/info')
const docsRouter = require('./routes/docs')
const buildModelsRouter = require('./routes/models')
const buildHealthRouter = require('./routes/health')
const buildRouter = require('./core/chat-router')
const { CONFIG } = require('./config/constants')
const { SessionSelector } = require('./core/session-selector')
const { toOpenAIError } = require('./utils/errors')
const { findPort } = require('./utils/find-port')
const { syncIdeConfig } = require('./utils/sync-ide-config')
const { sequentialQueue } = require('./utils/sequential-queue')
const { LogSaver } = require('./utils/log-saver')

const errorLog = new LogSaver({ name: 'errors', maxSize: 1024 * 1024 })

require('./utils/logger')

const app = express()

app.use(express.json({ limit: '50mb' }))

app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
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

app.use('/', docsRouter)
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
    app.use('/v1/chat/completions', sequentialQueue(), router)
  } catch (error) {
    console.error('Failed to build initial router:', error)
    process.exit(1)
  }

  app.use((err, req, res, _next) => {
    console.error('[Server] Unhandled error:', err.message || err)
    const openaiErr = toOpenAIError(err, preSelected.provider)
    const status = openaiErr.error?.status || err.statusCode || err.status || 500
    try {
      const { tools: _, ...body } = req.body
      errorLog.log(
        [
          `[${new Date().toISOString()}]`,
          `${req.method} ${req.originalUrl}`,
          `Status: ${status}`,
          `Message: ${err.message || err}`,
          err.stack || '',
          `Body: ${JSON.stringify(body, null, 2)}`,
        ].join('\n'),
      )
    } catch {}
    if (!res.headersSent) res.status(status).json(openaiErr)
    else res.end()
  })
  const server = app.listen(port, '127.0.0.1', () => {
    console.success(`\n√ ZeroKey running on http://localhost:${port}`)
    console.log('')
    console.log(`  POST  http://localhost:${port}/v1/chat/completions   Chat (SSE)`)
    console.log(`  GET   http://localhost:${port}/v1/models             List models`)
    console.log(`  GET   http://localhost:${port}/docs                  Swagger UI`)
    console.log(`\n  IDE: Authorization: Bearer <vscode|terax|opencode> (default: vscode)\n`)
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

  process.on('uncaughtException', (err) => {
    try {
      errorLog.log(
        [
          `[${new Date().toISOString()}] uncaughtException`,
          `Message: ${err && (err.message || err)}`,
          (err && err.stack) || '',
        ].join('\n'),
      )
    } catch {}
    console.error('[Server] uncaughtException:', (err && (err.stack || err.message)) || err)
    selector.flush()
    process.exit(1)
  })

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    try {
      errorLog.log(
        [
          `[${new Date().toISOString()}] unhandledRejection`,
          `Message: ${err.message}`,
          err.stack || '',
        ].join('\n'),
      )
    } catch {}
    console.error('[Server] unhandledRejection:', err.stack || err.message)
  })
})()
