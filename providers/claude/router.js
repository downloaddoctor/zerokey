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
const SYNTAX = require('../../engine/syntax')
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

    if (pipeline.ephemeralMode) return pipeline.sendFinalChunk()

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

          // Await the handler itself (it awaits the limit/summary callback), not
          // onFinalChunk: that fires at stream end, before the summary request
          // runs, so the loop would flushFinish and close the stream first.
          let limitHandled = false
          await claudeStreamHandler(stream, activeSession, pipeline, async (limitReached) => {
            if (!limitReached?.resets_at) return
            limitHandled = true
            userData.waitUntil = limitReached.resets_at * 1000
            userData.waitReason = 'Claude rate limit'

            const resetTime = new Date(userData.waitUntil).toLocaleTimeString()
            const mins = Math.max(1, Math.ceil((userData.waitUntil - Date.now()) / 60000))
            const overUtilized = limitReached.util >= 1.0

            if (overUtilized) {
              console.warn(`[Claude] ⚠ Usage at ${limitReached.pct} — over limit, skipping summary`)
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
              console.error('claudeApi.chatCompletion() failed:', summaryErr)
              console.error(`[Claude] Summary failed: ${summaryErr.message}`)
              emitLimitResponse(
                pipeline,
                userData.waitUntil,
                `Could not generate a conversation summary - usage is already over the limit (${limitReached.pct}), so this request was rejected too`,
              )
            }
          })
          // The summary/limit text already went to the client; hand the loop an
          // empty turn so it cannot parse it as a mixed block and start a repair
          // round against a rate-limited account.
          return { assistantText: limitHandled ? '' : pipeline.assistantText }
        },
      })
      pipeline.flushFinish()
    } catch (error) {
      console.error('runToolLoop() failed:', error)
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
      } catch (caughtErr) {
        console.error('JSON.parse() failed:', caughtErr)
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
  while (true) {
    attempt += 1
    await acquireSlot('Claude')
    try {
      return await fn()
    } catch (error) {
      console.error('claude router request failed:', error)
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
  return `\n${SYNTAX.OPEN}ask${SYNTAX.SEP}ques=This Claude session has reached its usage limit. It resets at ${resetTime} (~${mins} min). What would you like to do?${SYNTAX.SEP}option=Switch to another Claude user${SYNTAX.SEP}option=Switch to another provider${SYNTAX.SEP}option=Please Continue${SYNTAX.CLOSE}`
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
  // A limit response is terminal. Under deferFinish, sendFinalChunk only marks
  // the turn done and the stream stays open, so end it here.
  parser.deferFinish = false
  parser.sendFinalChunk()
}

module.exports = { buildClaudeRouter, withRetry }
