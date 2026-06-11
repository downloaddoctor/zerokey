const express = require('express')
const { CONFIG } = require('./config/constants')
const modelsRouter = require('./routes/models')
const healthRouter = require('./routes/health')
const { buildChatRouter } = require('./routes/deepseek')
const { buildChatGPTRouter } = require('./routes/chatgpt')
const { buildClaudeRouter } = require('./routes/claude')
const { SessionSelector } = require('./core/session-selector')
const { toOpenAIError } = require('./utils/errors')

const app = express()

app.use(express.json({ limit: '50mb' }))

// Middleware: request logging
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

// Middleware: extract IDE from Authorization header per-request
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

// Interactive startup wizard: Provider → User → Session, then start server
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

  try {
    // Mount chat route based on provider
    let chatRouter
    if (preSelected.provider === 'chatgpt') {
      chatRouter = await buildChatGPTRouter(
        preSelected.parsedFetch,
        preSelected.session,
        preSelected.saveSession,
        preSelected.userData,
      )
    } else if (preSelected.provider === 'claude') {
      chatRouter = await buildClaudeRouter(
        preSelected.parsedFetch,
        preSelected.session,
        preSelected.saveSession,
        preSelected.userData,
      )
    } else {
      chatRouter = await buildChatRouter(
        preSelected.parsedFetch.headers,
        preSelected.session,
        preSelected.saveSession,
      )
    }

    app.use('/v1/chat/completions', chatRouter)

    // Error-handling middleware (must be last, after all routes)
    app.use((err, req, res, _next) => {
      console.error('[Server] Unhandled error:', err.message || err)
      const openaiErr = toOpenAIError(err, preSelected.provider || 'server')
      const status = openaiErr.error?.status || err.statusCode || err.status || 500
      if (!res.headersSent) {
        res.status(status).json(openaiErr)
      } else {
        res.end()
      }
    })

    // Check if desired port is available, find next free one if not
    const checkPort = async (p) => {
      try {
        const res = await fetch(`http://localhost:${p}`)
        return false
      } catch (e) {
        return true
      }
    }

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

    const server = app.listen(port, () => {
      console.log(`\n✅ ZeroKey running on http://localhost:${port}`)
      console.log('Endpoints:')
      console.log(`  GET  http://localhost:${port}/`)
      console.log(`  GET  http://localhost:${port}/health`)
      console.log(`  GET  http://localhost:${port}/v1/models`)
      console.log(`  POST http://localhost:${port}/v1/chat/completions`)
      console.log(`\n  IDE from Authorization: Bearer <vscode|terax|opencode> (default: vscode)\n`)
    })

    // Graceful shutdown
    const shutdown = (signal) => {
      console.log(`\n[Server] ${signal} received — shutting down...`)
      server.close(() => {
        console.log('[Server] Closed.')
        process.exit(0)
      })
      // Force exit after 5s if still hanging
      setTimeout(() => {
        console.error('[Server] Forced shutdown after timeout.')
        process.exit(1)
      }, 5000)
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
  } catch (error) {
    console.error('Failed to start server:', error)
    process.exit(1)
  }
})()
