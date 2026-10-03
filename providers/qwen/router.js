'use strict'

const express = require('express')

const { StreamPipeline } = require('../../engine/pipeline')
const { QwenAPI } = require('./api')
const { streamHandler } = require('./stream-handler')
const { setQwenInstructions } = require('./set-instructions')
const { acquireSlot } = require('../../utils/rate-limiter')
const retry = require('../../utils/retry')
const { models } = require('./config')

const QWEN_MODELS = models.models

const qwenApi = new QwenAPI()

async function buildQwenRouter(parsedFetch, session, userData = null) {
  console.debug('[Qwen] Initializing from parsed capture JSON')
  await qwenApi.initializeFromJSON(parsedFetch)

  if (!session) throw new Error('No session provided')

  if (!session.chatSessionId) {
    const chatId = await qwenApi.createChatSession(session.model || 'qwen3.7-max')
    session.chatSessionId = chatId
  }

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [], tools, reasoning_effort: rawReasoningEffort = null } = req.body
    const pipeline = new StreamPipeline(res, session, 'qwen', req.surface, req.isRealSession)
    const activeSession = pipeline.session

    const modelMeta = QWEN_MODELS[activeSession.model] || QWEN_MODELS[session.model] || {}
    const allowedModes = modelMeta.reasoning || []
    let reasoningEffort = rawReasoningEffort
    if (allowedModes.length === 0) {
      reasoningEffort = null
    } else if (!reasoningEffort || !allowedModes.includes(reasoningEffort)) {
      reasoningEffort = allowedModes[0]
    }

    if (pipeline.isNewSession && !pipeline.rawMode) {
      await setQwenInstructions(qwenApi, userData, pipeline.toolCalling)
      pipeline.haveInstructionsAPI = true
    }

    if (!activeSession.chatSessionId) {
      activeSession.chatSessionId = await qwenApi.createChatSession(
        activeSession.model || 'qwen3.7-max',
      )
    }

    const fileIds = []
    pipeline.bindUploader(qwenApi, fileIds)

    const { prompt, handled } = await pipeline.setup(messages, tools, req)
    if (handled) return

    if (pipeline.ephemeralMode) {
      pipeline.onFinalChunk = () => {
        if (activeSession.chatSessionId) {
          qwenApi.deleteSession(activeSession.chatSessionId).catch(() => {})
        }
      }
    }

    try {
      const qwenStream = await withRetry(
        () =>
          qwenApi.chatCompletion(
            activeSession.chatSessionId,
            prompt,
            activeSession.parentMessageId,
            { model: activeSession.model, reasoningEffort },
          ),
        pipeline,
      )

      const retryFn = async () => {
        await acquireSlot('Qwen', true)
        return qwenApi.chatCompletion(
          activeSession.chatSessionId,
          prompt,
          activeSession.parentMessageId,
          { model: activeSession.model, reasoningEffort },
        )
      }

      const onFinished = (responseId) => {
        qwenApi.selectMessage(activeSession.chatSessionId, responseId).catch(() => {})
      }
      streamHandler(qwenStream, activeSession, pipeline, retryFn, onFinished)
    } catch (error) {
      if (error?.code === 'RateLimited' && userData) {
        const waitMs = typeof error.waitMs === 'number' ? error.waitMs : 24 * 60 * 60 * 1000
        userData.waitUntil = Date.now() + waitMs
        userData.waitReason = 'daily_limit'
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
