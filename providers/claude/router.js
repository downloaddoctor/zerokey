const express = require('express')

const { StreamPipeline } = require('../../engine/pipeline')
const { ClaudeAPI } = require('./api')
const { claudeStreamHandler } = require('./stream-handler')
const { setClaudeInstructions } = require('./set-instructions')
const { acquireSlot } = require('../../utils/rate-limiter')
const { validateMessages } = require('../../utils/route-helpers')
const { models, reasoning } = require('./config')

const CLAUDE_MODELS = models.models
const PROVIDER_REASONING_LABELS = reasoning.labels

const claudeApi = new ClaudeAPI()

async function buildClaudeRouter(parsedFetch, session, userData = null) {
  console.debug('[Claude] Initializing from parsed capture JSON')
  await claudeApi.initializeFromJSON(parsedFetch)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [], tools, reasoning_effort: rawReasoningEffort = null } = req.body

    if (!validateMessages(messages, res)) return

    StreamPipeline.setSSEHeaders(res)
    const pipeline = new StreamPipeline(res, session, 'claude', req.ide, messages)
    const activeSession = pipeline.session
    const model = activeSession.model

    // Enforce per-model allowed reasoning modes; fall back to first allowed
    const modelMeta = CLAUDE_MODELS[model] || {}
    const allowedModes = modelMeta.reasoning || PROVIDER_REASONING_LABELS
    let reasoningEffort = rawReasoningEffort
    if (allowedModes.length === 0) {
      reasoningEffort = null
    } else if (rawReasoningEffort && !allowedModes.includes(rawReasoningEffort)) {
      reasoningEffort = allowedModes[0]
    }

    if (userData?.waitUntil && userData.waitUntil > Date.now()) {
      emitLimitResponse(
        pipeline,
        userData.waitUntil,
        `This user's usage quota is still over its limit`,
      )
      return
    }

    if (pipeline.isNewSession && !pipeline.rawMode) {
      await setClaudeInstructions(claudeApi, userData, pipeline.toolCalling)
      pipeline.haveInstructionsAPI = true
    }

    const fileIds = []
    pipeline.bindUploader(claudeApi, fileIds)

    const { prompt, handled } = await pipeline.setup(messages, tools, req)
    if (handled) return

    if (pipeline.ephemeralMode) {
      pipeline.onFinalChunk = () => {
        if (activeSession.chatSessionId) {
          claudeApi.deleteSession(activeSession.chatSessionId).catch(() => {})
        }
      }
    }

    await acquireSlot('Claude')

    try {
      const { stream, chatSessionId } = await claudeApi.chatCompletion(
        prompt,
        activeSession.chatSessionId,
        activeSession.parentMessageId,
        model,
        [],
        fileIds,
        reasoningEffort,
        pipeline.ephemeralMode,
      )

      if (chatSessionId && !activeSession.chatSessionId) {
        activeSession.chatSessionId = chatSessionId
      }

      await claudeStreamHandler(stream, activeSession, pipeline, async (limitReached) => {
        if (limitReached?.resets_at) {
          userData.waitUntil = limitReached.resets_at * 1000
          userData.waitReason = 'Claude rate limit'

          const resetTime = new Date(userData.waitUntil).toLocaleTimeString()
          const mins = Math.max(1, Math.ceil((userData.waitUntil - Date.now()) / 60000))
          const overUtilized = limitReached.util >= 1.0

          if (overUtilized) {
            console.warn(`[Claude] ⚠ Usage at ${limitReached.pct} — over limit, skipping summary`)
            emitLimitResponse(
              pipeline,
              userData.waitUntil,
              `This user's usage quota has already been reached (${limitReached.pct})`,
            )
            return
          }

          console.warn(`[Claude] ⚠ Usage at ${limitReached.pct} — requesting summary`)

          try {
            const summaryPrompt = `Please write a concise but complete summary of this entire conversation — so it can be pasted into a fresh session to resume work seamlessly.`
            const { stream: summaryStream } = await claudeApi.chatCompletion(
              summaryPrompt,
              activeSession.chatSessionId,
              activeSession.parentMessageId,
              model,
              [],
            )

            pipeline.scan('\n\n````text\n')
            await claudeStreamHandler(summaryStream, activeSession, pipeline, () => {
              pipeline.scan('\n````')
              pipeline.scan(limitMessageText(resetTime, mins))
              pipeline.sendFinalChunk()
            })
          } catch (summaryErr) {
            console.error(`[Claude] Summary failed: ${summaryErr.message}`)
            emitLimitResponse(
              pipeline,
              userData.waitUntil,
              `Could not generate a conversation summary — usage is already over the limit (${limitReached.pct}), so this request was rejected too`,
            )
          }

          return
        }
      })
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
          emitLimitResponse(
            pipeline,
            userData.waitUntil,
            `This user's usage quota has been reached`,
          )

          return
        }
      } catch {}

      return pipeline.onError(error)
    }
  })

  return router
}

function limitMessageText(resetTime, mins) {
  return `\n⟦ask¦question=This Claude session has reached its usage limit. It resets at ${resetTime} (~${mins} min). What would you like to do?¦option=Switch to another Claude user¦default=true¦option=Switch to another provider¦option=Please Continue⟧`
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

module.exports = { buildClaudeRouter }
