'use strict'

/**
 * HTTP entry point. Loaded by scripts/start.js — never invoked directly.
 *
 * Bind address is fixed to loopback. Remote access goes through an SSH tunnel
 * (ssh -L 7250:127.0.0.1:7250), not through a second bind or a firewall rule.
 */

const express = require('express')
const { CONFIG } = require('./config/constants')
const log = require('./utils/log')

const infoRouter = require('./routes/info')
const docsRouter = require('./routes/docs')
const buildModelsRouter = require('./routes/models')
const buildHealthRouter = require('./routes/health')
const buildRouter = require('./core/chat-router')
const { toOpenAIError } = require('./utils/errors')
const { syncIdeConfig } = require('./utils/sync-ide-config')
const { sequentialQueue } = require('./utils/sequential-queue')
const { classifySession } = require('./utils/session-classifier')
const { validateMessages } = require('./utils/route-helpers')
const { StreamPipeline } = require('./engine/pipeline')
const { LogSaver } = require('./utils/log-saver')

const errorLog = new LogSaver({ name: 'errors', maxSize: 1024 * 1024 })

require('./utils/logger')

let httpServer = null

const app = express()
app.use(express.json({ limit: '50mb' }))

const prepareChatRequest = (req, res, next) => {
  if (!validateMessages(req.body?.messages, res)) return
  StreamPipeline.setSSEHeaders(res)
  const { isReal, surface, matched } = classifySession(req.body?.messages)
  req.surface = surface
  req.isRealSession = isReal
  req.matchedSurface = matched
  next()
}

app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    log.debug(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`,
    )
  })
  next()
})

app.use('/', docsRouter)
app.use('/', infoRouter)

async function start({ db, preSelected }) {
  if (!preSelected) throw new Error('start() requires preSelected session context.')
  if (!db) throw new Error('start() requires an open SQLite handle.')

  app.use('/', buildHealthRouter(preSelected, { db }))
  app.use('/v1/models', buildModelsRouter(preSelected))

  await syncIdeConfig(preSelected, CONFIG.PORT)

  let router
  try {
    router = await buildRouter(preSelected)
  } catch (error) {
    log.error('Failed to build initial router: ' + (error.message || error))
    throw error
  }
  app.use('/v1/chat/completions', sequentialQueue(), prepareChatRequest, router)

  app.use((err, req, res, _next) => {
    log.error('[Server] Unhandled error: ' + (err.message || err))
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

  await new Promise((resolve, reject) => {
    httpServer = app.listen(CONFIG.PORT, CONFIG.HOST, () => {
      log.info(`ZeroKey listening on http://${CONFIG.HOST}:${CONFIG.PORT} (PID ${process.pid})`)
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
