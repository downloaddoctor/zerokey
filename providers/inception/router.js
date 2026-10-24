'use strict'

const crypto = require('crypto')
const express = require('express')

const { StreamPipeline } = require('../../engine/pipeline')
const { InceptionApi } = require('./api')
const { getSharedTransport } = require('./browser-transport')

const { streamHandler, collectReply } = require('./stream-handler')
const instructions = require('../../engine/instructions')
const { acquireSlot, setProviderCooldown } = require('../../utils/rate-limiter')
const retry = require('../../utils/retry')
const { runToolLoop } = require('../../core/mhi/loop')
const { CONFIG } = require('../../config/constants')
const { reasoning, summaryAt } = require('./config')
const { resolveSessionTransport } = require('../../utils/session-transport')

const DEFAULT_TRANSPORT = (process.env.INCEPTION_TRANSPORT || 'browser').toLowerCase()

function randomId() {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16)
}

// Summary-rotation prompt counter lives on the session row (metadata.promptCount).
function promptCountOf(s) {
  return (s.metadata && s.metadata.promptCount) || 0
}

function setPromptCount(s, n) {
  if (!s.metadata || typeof s.metadata !== 'object') s.metadata = {}
  s.metadata.promptCount = n
}

async function buildInceptionRouter(parsedFetch, session, userData = null) {
  const TRANSPORT = resolveSessionTransport(session, DEFAULT_TRANSPORT, ['browser', 'api'])
  const browser =
    TRANSPORT === 'api'
      ? new InceptionApi()
      : getSharedTransport({ username: userData && userData.username })
  await browser.initializeFromJSON(parsedFetch || {})
  console.debug('[Inception] transport=' + TRANSPORT)

  if (!session) throw new Error('No session provided')

  // The site keeps no server-side chat state and the browser UI keeps the thread,
  // so every start is a fresh conversation (parentId cleared so the instructions
  // ride in the first prompt again; prompt counter reset).
  session.id = randomId()
  session.parentId = null
  setPromptCount(session, 0)

  let carriedSummary = null

  // Ask Mercury for a session summary in the current thread, then drop the
  // thread so the next real turn opens a new chat with base prompt + summary.
  async function rotateWithSummary(pipeline, reasoningEffort, signal) {
    const { content } = instructions.getExtra('summary')
    const stream = await withRetry(
      () =>
        browser.chatCompletion({
          prompt: content,
          messages: [{ role: 'user', content }],
          fresh: false,
          reasoningEffort,
          signal,
        }),
      pipeline,
    )
    const summary = (await collectReply(stream)).trim()
    if (!summary) throw new Error('[Inception] summary request returned an empty reply')
    carriedSummary = summary
    session.parentId = null
    setPromptCount(session, 0)
    console.info('[Inception] summary captured — next turn starts a new chat')
  }

  const router = express.Router()

  router.post('/', async (req, res) => {
    const pipeline = new StreamPipeline(res, session, 'inception', req.surface, req.isRealSession)
    const active = pipeline.session
    const ephemeral = pipeline.ephemeralMode

    const map = reasoning.map
    const { effort: reasoningEffort, search: webSearch } =
      map[req.body.reasoning_effort] || map.Medium

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

          // Real user prompts only: tool-loop rounds (role 'mhi') are not counted.
          const lastRole = (payload.messages[payload.messages.length - 1] || {}).role
          let newThread = false
          if (!ephemeral && lastRole !== 'mhi') {
            setPromptCount(active, promptCountOf(active) + 1)
            if (promptCountOf(active) >= summaryAt) {
              try {
                await rotateWithSummary(pipeline, reasoningEffort, req.signal)
                newThread = true
                // Client-only notice: pipeline.emit skips assistantText, so the MHI loop and history never see it.
                pipeline.emit({
                  role: 'assistant',
                  content:
                    '\n> ♻ New session started: previous chat summarized and carried over.\n\n',
                })
              } catch (summaryErr) {
                console.error('inception: summary rotation failed:', summaryErr)
              }
            }
          }

          // New chat after a summary: base prompt (when the pipeline did not
          // already add it) + the carried summary, then the current prompt.
          let sendPrompt = prompt
          if (newThread && carriedSummary) {
            const base =
              !pipeline.isNewSession && pipeline.toolCalling
                ? instructions.getFull().content + '\n\n'
                : ''
            sendPrompt = `${base}<previous_session_summary>\n${carriedSummary}\n</previous_session_summary>\n\n${prompt}`
            carriedSummary = null
          }

          const stream = await withRetry(
            () =>
              browser.chatCompletion({
                prompt: sendPrompt,
                messages: payload.messages,
                newThread,
                fresh: ephemeral,
                reasoningEffort,
                webSearch,
                signal: req.signal,
              }),
            pipeline,
          )

          const reply = await streamHandler(stream, active, pipeline)

          if (!ephemeral && reply) active.parentId = randomId()
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

module.exports = { buildInceptionRouter, withRetry }
