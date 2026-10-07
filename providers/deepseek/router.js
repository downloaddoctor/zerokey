'use strict'

const express = require('express')

const { StreamPipeline } = require('../../engine/pipeline')
const { DeepSeekAPI } = require('./api')
const { getSharedTransport } = require('./browser-transport')
const { streamHandler } = require('./stream-handler')
const { acquireSlot } = require('../../utils/rate-limiter')
const retry = require('../../utils/retry')
const { runToolLoop } = require('../../core/mhi/loop')
const { CONFIG } = require('../../config/constants')
const { reasoning } = require('./config')

const TRANSPORT = (process.env.DEEPSEEK_TRANSPORT || 'browser').toLowerCase()

const REASONING_MAP = reasoning.map

async function buildDeepSeekRouter(parsedFetch, session, userData) {
  const username = userData?.username
  if (TRANSPORT !== 'api' && !username) {
    throw new Error('[DEEPSEEK] userData.username (local key) is required for browser transport')
  }
  const deepseekApi = TRANSPORT === 'api' ? new DeepSeekAPI() : getSharedTransport({ username })

  console.debug('[DEEPSEEK] Initializing from parsed capture JSON')
  await deepseekApi.initializeFromJSON(parsedFetch)

  if (!session) throw new Error('No session provided')

  if (!session.id) {
    try {
      session.id = await deepseekApi.createChatSession()
    } catch (error) {
      console.error('deepseek: createChatSession failed for session "' + session.name + '":', error)
      if (error.code === 'account_suspended' && error.muteUntil != null && userData) {
        userData.waitUntil = Math.ceil(error.muteUntil * 1000)
        userData.waitReason = 'account_suspended'
      }
      throw error
    }
  }

  const router = express.Router()

  router.post('/', async (req, res) => {
    const pipeline = new StreamPipeline(res, session, 'deepseek', req.surface, req.isRealSession)

    if (pipeline.ephemeralMode) {
      pipeline.sendFinalChunk()
      return
    }

    const activeSession = pipeline.session
    if (!activeSession.id) {
      try {
        activeSession.id = await deepseekApi.createChatSession()
      } catch (error) {
        console.error('deepseek: rebind createChatSession failed:', error)
        if (error.code === 'account_suspended' && error.muteUntil && userData) {
          userData.waitUntil = Math.ceil(error.muteUntil * 1000)
          userData.waitReason = 'account_suspended'
        }
        return pipeline.onError(error)
      }
    }
    const modelType = pipeline.isNewSession ? activeSession.model || 'default' : null
    const { think: thinkingEnabled, search: searchEnabled } = REASONING_MAP[
      req.body.reasoning_effort
    ] ?? { think: false, search: false }

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
          const fileIds = []
          pipeline.bindUploader(deepseekApi, fileIds)

          const { prompt, handled } = await pipeline.setup(payload.messages, payload.tools, req)
          if (handled) return { assistantText: '' }

          pipeline.beginTurn()

          const deepseekStream = await withRetry(
            () =>
              deepseekApi.chatCompletion(
                activeSession.id,
                prompt,
                activeSession.parentId,
                thinkingEnabled,
                searchEnabled,
                modelType,
                fileIds,
              ),
            pipeline,
            'DeepSeek',
          )

          const retryFn = async () => {
            await acquireSlot('DeepSeek', true)
            return deepseekApi.chatCompletion(
              activeSession.id,
              prompt,
              activeSession.parentId,
              thinkingEnabled,
              searchEnabled,
              modelType,
              fileIds,
            )
          }

          await new Promise((resolve) => {
            const originalOnFinalChunk = pipeline.onFinalChunk
            pipeline.onFinalChunk = () => {
              if (originalOnFinalChunk) originalOnFinalChunk()
              resolve()
            }
            streamHandler(deepseekStream, activeSession, pipeline, retryFn)
          })
          return { assistantText: pipeline.assistantText }
        },
      })
      pipeline.flushFinish()
    } catch (error) {
      console.error('runToolLoop() failed:', error)
      if (error.code === 'account_suspended' && error.muteUntil && userData) {
        userData.waitUntil = Math.ceil(error.muteUntil * 1000)
        userData.waitReason = 'account_suspended'
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

async function withRetry(fn, pipeline, label) {
  let attempt = 0
  for (;;) {
    attempt += 1
    await acquireSlot(label)
    try {
      return await fn()
    } catch (error) {
      console.error('deepseek router request failed:', error)
      if (error && error.code === 'account_suspended') throw error
      const policy = retry.classify(error, pipeline && pipeline.signal)
      if (!policy.retry || attempt >= policy.maxAttempts) throw error
      retry.discardResponse(error.response)
      const delay = retry.delayMs(attempt, error.response)
      console.warn(
        `[${label}] Retrying after ${policy.kind} (attempt ${attempt + 1}/${policy.maxAttempts}, wait ${delay}ms)`,
      )
      await retry.sleep(delay, pipeline && pipeline.signal)
    }
  }
}

module.exports = { buildDeepSeekRouter, withRetry }
