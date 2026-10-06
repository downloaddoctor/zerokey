'use strict'

/**
 * The express application. Pure module: requiring this file has no side
 * effects. server.js calls start() with an open database, a preSelected
 * session context, and the port chosen at boot.
 */

const express = require('express')
const { CONFIG } = require('./config/constants')
const diagnostics = require('./utils/diagnostics')

const infoRouter = require('./routes/info')
const docsRouter = require('./routes/docs')
const buildModelsRouter = require('./routes/models')
const buildHealthRouter = require('./routes/health')
const buildDiagnosticsRouter = require('./routes/diagnostics')
const buildRouter = require('./core/chat-router')
const { toOpenAIError } = require('./utils/errors')
const { syncIdeConfig } = require('./utils/sync-ide-config')
const { sequentialQueue } = require('./utils/sequential-queue')
const { classifySession } = require('./utils/session-classifier')
const { validateMessages } = require('./utils/route-helpers')
const { StreamPipeline } = require('./engine/pipeline')

let httpServer = null

const app = express()
app.use(express.json({ limit: '50mb' }))

const prepareChatRequest = (req, res, next) => {
  if (!validateMessages(req.body?.messages, res)) return
  StreamPipeline.setSSEHeaders(res)
  const { isReal, surface, matched } = classifySession(req.body?.messages)
  if (!isReal) {
    console.debug(`[SERVER] EPHEMERAL ${req.method} ${req.originalUrl} — surface=${surface}`)
  }

  req.surface = surface
  req.isRealSession = isReal
  req.matchedSurface = matched
  next()
}

app.use((req, res, next) => {
  const started = Date.now()
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  Object.defineProperty(req, 'signal', { value: controller.signal, configurable: true })
  res.on('finish', () => {
    console.debug(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`,
    )
  })
  next()
})

app.use('/', docsRouter)
app.use('/', infoRouter)

async function start({ db: store, preSelected, port }) {
  if (!preSelected) throw new Error('start() requires preSelected session context.')
  if (!store) throw new Error('start() requires an open SQLite handle.')
  const boundPort = Number.isInteger(port) ? port : CONFIG.PORT

  const startedAt = Date.now()

  let providerStatus = null
  try {
    const registry = require('./providers/registry')
    const provider = registry.get(preSelected.provider)
    providerStatus = diagnostics.providerStatusPayload(provider, preSelected)
  } catch (error) {
    console.error('failed to require a route module:', error)
    providerStatus = { error: error.message }
  }

  app.use('/', buildHealthRouter(preSelected, { db: store }))
  app.use('/v1/models', buildModelsRouter(preSelected))
  app.use(
    '/v1/diagnostics',
    buildDiagnosticsRouter({
      host: CONFIG.HOST,
      port: boundPort,
      startedAt,
      db: store,
      providerStatus,
    }),
  )

  await syncIdeConfig(preSelected, boundPort)

  let router
  try {
    router = await buildRouter(preSelected, {
      db: store,
      userId: preSelected.userId || preSelected.userData?.id || null,
      sessionName: preSelected.sessionName,
    })
  } catch (error) {
    console.error('buildRouter() failed for provider ' + preSelected.provider + ':', error)
    console.error('Failed to build initial router:', error)
    throw error
  }
  app.use('/v1/chat/completions', sequentialQueue(), prepareChatRequest, router)

  app.use((err, req, res, _next) => {
    const openaiErr = toOpenAIError(err, preSelected.provider)
    const status = openaiErr.error?.status || err.statusCode || err.status || 500
    let body = null
    try {
      const { tools: _, ...rest } = req.body || {}
      body = rest
    } catch (caughtErr) {
      console.error('error handler could not serialize req.body:', caughtErr)
    }
    console.error(`[SERVER] ${req.method} ${req.originalUrl} → ${status}`, err, {
      provider: preSelected.provider,
      status,
      category: openaiErr.error?.category,
      body,
    })
    if (!res.headersSent) res.status(status).json(openaiErr)
    else res.end()
  })

  await new Promise((resolve, reject) => {
    httpServer = app.listen(boundPort, CONFIG.HOST, () => {
      const HOST = `http://${CONFIG.HOST}:${boundPort}`
      console.warn(`\n√ ZeroKey running on ${HOST} (PID ${process.pid})`, 1)
      console.log('', 1)
      console.log(`  POST  ${HOST}/v1/chat/completions   Chat (SSE)`, 1)
      console.log(`  GET   ${HOST}/v1/models             List models`, 1)
      console.log(`  GET   ${HOST}/docs                  Swagger UI`, 1)

      resolve()
    })
    httpServer.once('error', reject)
  })

  return httpServer
}

async function stop() {
  if (httpServer === null) return
  await new Promise((resolve) => httpServer.close(resolve))
  httpServer = null
}

module.exports = { app, start, stop }
