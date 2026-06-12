const express = require('express')
const { CONFIG } = require('./config/constants')
const modelsRouter = require('./routes/models')
const healthRouter = require('./routes/health')
const { SessionSelector } = require('./core/session-selector')
const { ChatRouter } = require('./core/chat-router')
const { toOpenAIError } = require('./utils/errors')

const app = express()

app.use(express.json({ limit: '50mb' }))

app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    const bodySize = req.body?.messages?.length ? `${req.body.messages.length} msgs` : '-'
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${duration}ms) | IDE: ${req.ide || '?'} | body: ${bodySize}`,
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

app.use('/v1/models', modelsRouter)
app.use('/', healthRouter)
;(async () => {
  const selector = new SessionSelector()
  const preSelected = await selector.select()

  if (!preSelected) {
    console.error('No session selected. Exiting.')
    process.exit(0)
  }

  console.log(
    `\n[Server] ${preSelected.user} - ${preSelected.provider} - ${preSelected.sessionName}\n`,
  )

  const chatRouter = new ChatRouter(selector)

  app.use('/v1/chat/completions', chatRouter.middleware())

  app.use((err, req, res, _next) => {
    console.error('[Server] Unhandled error:', err.message || err)
    const openaiErr = toOpenAIError(err, chatRouter.selected?.provider || 'server')
    const status = openaiErr.error?.status || err.statusCode || err.status || 500
    if (!res.headersSent) res.status(status).json(openaiErr)
    else res.end()
  })

  const checkPort = (p) =>
    new Promise((resolve) => {
      const net = require('net')
      const sock = new net.Socket()
      sock.setTimeout(400)
      sock
        .once('connect', () => {
          resolve((sock.destroy(), false))
        })
        .once('error', () => {
          resolve((sock.destroy(), true))
        })
        .once('timeout', () => {
          resolve((sock.destroy(), true))
        })
        .connect(p, '127.0.0.1')
    })

  let port = CONFIG.PORT
  const desiredPort = CONFIG.PORT
  while (!(await checkPort(port))) {
    port++
    if (port > desiredPort + 100) {
      console.error('No available ports found in range.')
      process.exit(1)
    }
  }
  if (port !== desiredPort) {
    console.warn(`\n⚠ Port ${desiredPort} is already in use. Using port ${port} instead.`)
  }

  try {
    await chatRouter.mount(preSelected)
  } catch (error) {
    console.error('Failed to build initial router:', error)
    process.exit(1)
  }

  const server = app.listen(port, () => {
    console.log(`\n✅ ZeroKey running on http://localhost:${port}`)
    console.log('Endpoints:')
    console.log(`  GET  http://localhost:${port}/`)
    console.log(`  GET  http://localhost:${port}/health`)
    console.log(`  GET  http://localhost:${port}/v1/models`)
    console.log(`  POST http://localhost:${port}/v1/chat/completions`)
    console.log(`\n  IDE from Authorization: Bearer <vscode|terax|opencode> (default: vscode)\n`)
  })

  const shutdown = (signal) => {
    console.log(`\n[Server] ${signal} received — shutting down...`)
    selector.flush()
    server.close(() => {
      console.log('[Server] Closed.')
      process.exit(0)
    })
    setTimeout(() => {
      console.error('[Server] Forced shutdown after timeout.')
      process.exit(1)
    }, 5000)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
})()
