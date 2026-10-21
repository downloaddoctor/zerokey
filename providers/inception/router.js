'use strict'

const crypto = require('crypto')
const express = require('express')

const { StreamPipeline } = require('../../engine/pipeline')
const { getSharedTransport } = require('./browser-transport')

const { streamHandler } = require('./stream-handler')
const { acquireSlot, setProviderCooldown } = require('../../utils/rate-limiter')
const retry = require('../../utils/retry')
const { runToolLoop } = require('../../core/mhi/loop')
const { CONFIG } = require('../../config/constants')
const { reasoning } = require('./config')

const HISTORY_CHAR_CAP = 120_000

function randomId() {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16)
}

function historyChars(history) {
  return history.reduce((n, m) => n + JSON.stringify(m.parts).length, 0)
}

// Keep the first exchange (it carries the instructions); drop the oldest after it.
function trimHistory(history) {
  while (historyChars(history) > HISTORY_CHAR_CAP && history.length > 4) history.splice(2, 2)
}

async function buildInceptionRouter(parsedFetch, session, userData = null) {
  console.debug('[Inception] Browser-only transport, no capture required')
  const browser = getSharedTransport({ username: userData && userData.username })
  await browser.initializeFromJSON(parsedFetch || {})

  if (!session) throw new Error('No session provided')

  // The site keeps no server-side chat state: history lives in memory for this
  // process only, so every start is a fresh conversation (parentId cleared so
  // the instructions ride in the first prompt again).
  const history = []
  session.id = randomId()
  session.parentId = null

  const router = express.Router()

  router.post('/', async (req, res) => {
    const pipeline = new StreamPipeline(res, session, 'inception', req.surface, req.isRealSession)
    const active = pipeline.session
    const ephemeral = pipeline.ephemeralMode

    const map = reasoning.map
    const reasoningEffort = map[req.body.reasoning_effort] || map.Medium

    pipeline.deferFinish = true

    try {
      await runToolLoop({
        payload: { messages: req.body.messages || [], tools: req.body.tools },
        pipeline,
        config: CONFIG,
        signal: req.signal,
        turn: async (payload) => {
          const { prompt, handled } = await pipeline.setup(payload.messages, payload.tools, req)
          if (handled) return { assistantText: '' }

          pipeline.beginTurn()

          const userMsg = {
            id: randomId(),
            role: 'user',
            parts: [{ type: 'text', text: prompt }],
          }

          const stream = await withRetry(
            () =>
              browser.chatCompletion({
                prompt,
                fresh: ephemeral,
                reasoningEffort,
                signal: req.signal,
              }),
            pipeline,
          )

          const reply = await streamHandler(stream, active, pipeline)

          if (!ephemeral && reply) {
            const assistantMsg = {
              id: randomId(),
              role: 'assistant',
              parts: [
                { type: 'reasoning', id: 'reasoning-0', text: '', state: 'done' },
                { type: 'text', text: reply, state: 'done' },
              ],
            }
            history.push(userMsg, assistantMsg)
            trimHistory(history)
            active.parentId = assistantMsg.id
          }
          return { assistantText: pipeline.assistantText }
        },
      })
      pipeline.flushFinish()
    } catch (error) {
      console.error('runToolLoop() failed:', error)
      if (error && (error.status === 429 || error.statusCode === 429)) {
        setProviderCooldown('Inception', 60_000)
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
    await acquireSlot('Inception')
    try {
      return await fn()
    } catch (error) {
      console.error('inception router request failed:', error)
      const policy = retry.classify(error, pipeline && pipeline.signal)
      if (!policy.retry || attempt >= policy.maxAttempts) throw error
      retry.discardResponse(error.response)
      const delay = retry.delayMs(attempt, error.response)
      console.warn(
        `[Inception] Retrying after ${policy.kind} (attempt ${attempt + 1}/${policy.maxAttempts}, wait ${delay}ms)`,
      )
      await retry.sleep(delay, pipeline && pipeline.signal)
    }
  }
}

module.exports = { buildInceptionRouter, withRetry, trimHistory }
