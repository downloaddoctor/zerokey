'use strict'

const express = require('express')

const { StreamPipeline } = require('../../engine/pipeline')
const { QwenAPI } = require('./api')
const { streamHandler } = require('./stream-handler')
const { setQwenInstructions } = require('./set-instructions')
const { acquireSlot } = require('../../utils/rate-limiter')
const retry = require('../../utils/retry')
const { runToolLoop } = require('../../core/mhi/loop')
const { CONFIG } = require('../../config/constants')
const { models } = require('./config')

const QWEN_MODELS = models.models

const qwenApi = new QwenAPI()

async function buildQwenRouter(parsedFetch, session, userData = null) {
  console.debug('[Qwen] Initializing from parsed capture JSON')
  await qwenApi.initializeFromJSON(parsedFetch)

  if (!session) throw new Error('No session provided')

  if (!session.id) {
    // Non-fatal at startup: a transient upstream hiccup must not stop the server.
    // The request handler below creates the chat lazily on first use.
    try {
      session.id = await qwenApi.createChatSession(session.model || 'qwen3.7-max')
    } catch (error) {
      console.warn(
        '[Qwen] initial createChatSession failed, will retry on first request: ' + error.message,
      )
    }
  }

  const router = express.Router()

  router.post('/', async (req, res) => {
    const pipeline = new StreamPipeline(res, session, 'qwen', req.surface, req.isRealSession)
    const activeSession = pipeline.session

    const modelMeta = QWEN_MODELS[activeSession.model] || QWEN_MODELS[session.model] || {}
    const allowedModes = modelMeta.reasoning || []
    let reasoningEffort = req.body.reasoning_effort
    if (allowedModes.length === 0) {
      reasoningEffort = null
    } else if (!reasoningEffort || !allowedModes.includes(reasoningEffort)) {
      reasoningEffort = allowedModes[0]
    }

    if (!activeSession.id) {
      activeSession.id = await qwenApi.createChatSession(activeSession.model || 'qwen3.7-max')
    }

    pipeline.deferFinish = true

    try {
      await runToolLoop({
        payload: {
          messages: req.body.messages || [],
          tools: req.body.tools,
        },
        pipeline,
        config: CONFIG,
        signal: req.signal,
        turn: async (payload, _signal) => {
          if (pipeline.isNewSession && !pipeline.rawMode) {
            await setQwenInstructions(qwenApi, userData, pipeline.toolCalling)
            pipeline.haveInstructionsAPI = true
          }

          const fileIds = []
          pipeline.bindUploader(qwenApi, fileIds)

          const { prompt, handled } = await pipeline.setup(payload.messages, payload.tools, req)
          if (handled) return { assistantText: '' }

          pipeline.beginTurn()

          const qwenStream = await withRetry(
            () =>
              qwenApi.chatCompletion(activeSession.id, prompt, activeSession.parentId, {
                model: activeSession.model,
                reasoningEffort,
              }),
            pipeline,
          )

          const retryFn = async () => {
            await acquireSlot('Qwen', true)
            return qwenApi.chatCompletion(activeSession.id, prompt, activeSession.parentId, {
              model: activeSession.model,
              reasoningEffort,
            })
          }

          await new Promise((resolve) => {
            const originalOnFinalChunk = pipeline.onFinalChunk
            pipeline.onFinalChunk = () => {
              if (originalOnFinalChunk) originalOnFinalChunk()
              resolve()
            }
            const onFinished = (responseId) => {
              qwenApi.selectMessage(activeSession.id, responseId).catch((caughtErr) => {
                console.error('qwenApi.selectMessage() failed:', caughtErr)
              })
            }
            streamHandler(qwenStream, activeSession, pipeline, retryFn, onFinished)
          })
          return { assistantText: pipeline.assistantText }
        },
      })
      pipeline.flushFinish()
    } catch (error) {
      console.error('runToolLoop() failed:', error)
      if (error?.code === 'RateLimited' && userData) {
        const waitMs = typeof error.waitMs === 'number' ? error.waitMs : 24 * 60 * 60 * 1000
        userData.waitUntil = Date.now() + waitMs
        userData.waitReason = 'daily_limit'
      }
      if (pipeline.deferFinish) {
        pipeline.deferFinish = false
        pipeline._finished = false
      }
      return pipeline.onError(error)
    }
  })

  return router
}

async function withRetry(fn, pipeline) {
  let attempt = 0
  for (;;) {
    attempt += 1
    await acquireSlot('Qwen')
    try {
      return await fn()
    } catch (error) {
      console.error('qwen router request failed:', error)
      if (error && error.code === 'RateLimited') throw error
      const policy = retry.classify(error, pipeline && pipeline.signal)
      if (!policy.retry || attempt >= policy.maxAttempts) throw error
      retry.discardResponse(error.response)
      const delay = retry.delayMs(attempt, error.response)
      console.warn(
        `[Qwen] Retrying after ${policy.kind} (attempt ${attempt + 1}/${policy.maxAttempts}, wait ${delay}ms)`,
      )
      await retry.sleep(delay, pipeline && pipeline.signal)
    }
  }
}

module.exports = { buildQwenRouter, withRetry }
