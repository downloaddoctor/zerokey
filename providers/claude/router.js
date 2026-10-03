'use strict'

const express = require('express')

const { StreamPipeline } = require('../../engine/pipeline')
const { ClaudeAPI } = require('./api')
const { claudeStreamHandler } = require('./stream-handler')
const { setClaudeInstructions } = require('./set-instructions')
const { acquireSlot } = require('../../utils/rate-limiter')
const retry = require('../../utils/retry')
const { runToolLoop } = require('../../core/mhi/loop')
const { CONFIG } = require('../../config/constants')
const instructions = require('../../engine/instructions')
const { models, reasoning } = require('./config')

const CLAUDE_MODELS = models.models
const PROVIDER_REASONING_LABELS = reasoning.labels

const claudeApi = new ClaudeAPI()

async function buildClaudeRouter(parsedFetch, session, userData = null) {
  console.debug('[Claude] Initializing from parsed capture JSON')
  await claudeApi.initializeFromJSON(parsedFetch)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const pipeline = new StreamPipeline(res, session, 'claude', req.surface, req.isRealSession)
    const activeSession = pipeline.session
    const model = activeSession.model

    const modelMeta = CLAUDE_MODELS[model] || {}
    const allowedModes = modelMeta.reasoning || PROVIDER_REASONING_LABELS
    let reasoningEffort = req.body.reasoning_effort
    if (allowedModes.length === 0) {
      reasoningEffort = null
    } else if (reasoningEffort && !allowedModes.includes(reasoningEffort)) {
      reasoningEffort = allowedModes[0]
    }

    if (userData?.waitUntil && userData.waitUntil > Date.now()) {
      return emitLimitResponse(
        pipeline,
        userData.waitUntil,
        `This user's usage quota is still over its limit`,
      )
    }

    if (pipeline.isNewSession && !pipeline.rawMode) {
      await setClaudeInstructions(claudeApi, userData, pipeline.toolCalling)
      pipeline.haveInstructionsAPI = true
    }

    if (pipeline.ephemeralMode) {
      pipeline.onFinalChunk = () => {
        if (activeSession.id) {
          claudeApi.deleteSession(activeSession.id).catch(() => {})
        }
      }
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
          const fileIds = []
          pipeline.bindUploader(claudeApi, fileIds)

          const { prompt, handled } = await pipeline.setup(payload.messages, payload.tools, req)
          if (handled) return { assistantText: '' }

          pipeline.beginTurn()

          const { stream, chatSessionId } = await withRetry(
            () =>
              claudeApi.chatCompletion(
                prompt,
                activeSession.id,
                activeSession.parentId,
                model,
                [],
                fileIds,
                reasoningEffort,
                pipeline.ephemeralMode,
              ),
            pipeline,
          )

          if (chatSessionId && !activeSession.id) {
            activeSession.id = chatSessionId
          }

          await new Promise((resolve) => {
            const originalOnFinalChunk = pipeline.onFinalChunk
            pipeline.onFinalChunk = () => {
              if (originalOnFinalChunk) originalOnFinalChunk()
              resolve()
            }

            claudeStreamHandler(stream, activeSession, pipeline, async (limitReached) => {
              if (!limitReached?.resets_at) return
              userData.waitUntil = limitReached.resets_at * 1000
              userData.waitReason = 'Claude rate limit'

              const resetTime = new Date(userData.waitUntil).toLocaleTimeString()
              const mins = Math.max(1, Math.ceil((userData.waitUntil - Date.now()) / 60000))
              const overUtilized = limitReached.util >= 1.0

              if (overUtilized) {
                console.warn(
                  `[Claude] ⚠ Usage at ${limitReached.pct} — over limit, skipping summary`,
                )
                return emitLimitResponse(
                  pipeline,
                  userData.waitUntil,
                  `This user's usage quota has already been reached (${limitReached.pct})`,
                )
              }

              console.warn(`[Claude] ⚠ Usage at ${limitReached.pct} — requesting summary`)

              try {
                const { stream: summaryStream } = await claudeApi.chatCompletion(
                  instructions.getExtra('summary').content.trim(),
                  activeSession.id,
                  activeSession.parentId,
                  model,
                  [],
                )

                pipeline.scan('\n\n````text\n')
                await claudeStreamHandler(summaryStream, activeSession, pipeline)
                pipeline.scan('\n````')
                pipeline.scan(limitMessageText(resetTime, mins))
              } catch (summaryErr) {
                console.error(`[Claude] Summary failed: ${summaryErr.message}`)
                emitLimitResponse(
                  pipeline,
                  userData.waitUntil,
                  `Could not generate a conversation summary - usage is already over the limit (${limitReached.pct}), so this request was rejected too`,
                )
              }
            })
          })
          return { assistantText: pipeline.assistantText }
        },
      })
      pipeline.flushFinish()
    } catch (error) {
      console.error(`[Claude] Route error: ${error.message}`)

      try {
        const raw = JSON.parse(error.message)
        const payload = raw?.error?.message ? JSON.parse(raw.error.message) : null
        const limit = payload?.resolved?.limit
        const reset = limit?.resets_at || payload?.windows?.['5h']?.resets_at || payload?.resetsAt

        if (reset) {
          userData.waitUntil = typeof reset === 'number' ? reset * 1000 : new Date(reset).getTime()
          userData.waitReason = limit?.title || payload?.notice?.title || 'Claude rate limit'
        }

        if (payload?.resolved?.status === 'exceeded') {
          return emitLimitResponse(
            pipeline,
            userData.waitUntil,
            `This user's usage quota has been reached`,
          )
        }
      } catch {}

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
    await acquireSlot('Claude')
    try {
      return await fn()
    } catch (error) {
      if (error && error.status === 429) throw error
      const policy = retry.classify(error, pipeline && pipeline.signal)
      if (!policy.retry || attempt >= policy.maxAttempts) throw error
      retry.discardResponse(error.response)
      const delay = retry.delayMs(attempt, error.response)
      console.warn(
        `[Claude] Retrying after ${policy.kind} (attempt ${attempt + 1}/${policy.maxAttempts}, wait ${delay}ms)`,
      )
      await retry.sleep(delay, pipeline && pipeline.signal)
    }
  }
}

function limitMessageText(resetTime, mins) {
  const OPEN = String.fromCodePoint(0x27e6)
  const CLOSE = String.fromCodePoint(0x27e7)
  const SEP = String.fromCodePoint(0xa6)
  const question =
    'This Claude session has reached its usage limit. It resets at ' +
    resetTime +
    ' (~' +
    mins +
    ' min). What would you like to do?'
  return (
    '\n' +
    OPEN +
    'ask' +
    SEP +
    'question=' +
    question +
    SEP +
    'option=Switch to another Claude user' +
    SEP +
    'default=true' +
    SEP +
    'option=Switch to another provider' +
    SEP +
    'option=Please Continue' +
    CLOSE
  )
}

function computeReset(waitUntilMs) {
  const resetTime = new Date(waitUntilMs).toLocaleTimeString()
  const mins = Math.max(1, Math.ceil((waitUntilMs - Date.now()) / 60000))
  return { resetTime, mins }
}

function emitLimitResponse(parser, waitUntilMs, prefix) {
  const { resetTime, mins } = computeReset(waitUntilMs)
  parser.scan(`\n\n⚠ ${prefix} — it needs ~${mins} min to reset at ${resetTime}.\n`)
  parser.scan(limitMessageText(resetTime, mins))
  parser.sendFinalChunk()
}

module.exports = { buildClaudeRouter, withRetry }
