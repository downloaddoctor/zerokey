'use strict'

const crypto = require('crypto')
const express = require('express')

const { StreamPipeline } = require('../../engine/pipeline')
const { InceptionApi } = require('./api')
const { getSharedTransport } = require('./browser-transport')

const { streamHandler, collectReply } = require('./stream-handler')
const instructions = require('../../engine/instructions')
const { setProviderCooldown } = require('../../utils/rate-limiter')
const { withRetry: sharedWithRetry } = require('../../utils/with-retry')
const { runToolLoop } = require('../../core/mhi/loop')

const withRetry = (fn, pipeline) => sharedWithRetry(fn, { pipeline, label: 'Inception' })
const { CONFIG } = require('../../config/constants')
const { reasoning, summaryAt, summaryAtTokens } = require('./config')

// Rough size of the upstream thread (~4 chars per token), used to rotate before the 150k limit.
function estimateThreadTokens(messages) {
  let chars = 0
  for (const m of messages) chars += String((m && m.content) || '').length + 16
  return Math.ceil(chars / 4)
}
const { resolveSessionTransport } = require('../../utils/session-transport')

const MAX_CONTINUES = 3
const DEFAULT_TRANSPORT = (process.env.INCEPTION_TRANSPORT || 'browser').toLowerCase()

function randomId() {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16)
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
  session.turnCount = 0

  let carriedSummary = null
  const thread = { messages: [] }

  // Ask Mercury for a session summary in the current thread, then drop the
  // thread so the next real turn opens a new chat with base prompt + summary.
  async function rotateWithSummary(pipeline, reasoningEffort, signal) {
    const { content } = instructions.getExtra('summary')
    const stream = await withRetry(
      () =>
        browser.chatCompletion({
          prompt: content,
          messages: [...thread.messages, { role: 'user', content }],
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
    session.turnCount = 0
    console.info('[Inception] summary captured — next turn starts a new chat')
  }

  const router = express.Router()

  router.post('/', async (req, res) => {
    const pipeline = new StreamPipeline(res, session, 'inception', req.surface, req.isRealSession)
    const active = pipeline.session
    if (pipeline.ephemeralMode) return pipeline.sendFinalChunk()

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

          // session.turnCount is counted by pipeline.setup (every upstream round).
          // Rotation is only checked on real user prompts, never mid tool loop (role 'mhi').
          const lastRole = (payload.messages[payload.messages.length - 1] || {}).role
          let newThread = false
          if (lastRole !== 'mhi') {
            if (
              (active.turnCount || 0) >= summaryAt ||
              estimateThreadTokens(thread.messages) >= summaryAtTokens
            ) {
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
                // Back off: retry in 5 turns instead of on every following prompt.
                active.turnCount = Math.max(0, summaryAt - 5)
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

          const sent = [
            ...(newThread || active.parentId == null ? [] : thread.messages),
            { role: 'user', content: sendPrompt },
          ]
          const stream = await withRetry(
            () =>
              browser.chatCompletion({
                prompt: sendPrompt,
                messages: sent,
                newThread,
                fresh: false,
                reasoningEffort,
                webSearch,
                signal: req.signal,
              }),
            pipeline,
          )

          let outcome = {}
          let reply = await streamHandler(stream, active, pipeline, outcome)
          // Upstream 'Something went wrong' frame: keep the thread and send 'continue'.
          for (let n = 0; outcome.error && n < MAX_CONTINUES; n += 1) {
            console.warn(
              `[Inception] stream error "${outcome.error}" - sending continue (${n + 1}/${MAX_CONTINUES})`,
            )
            const next = await withRetry(
              () =>
                browser.chatCompletion({
                  prompt: 'continue',
                  messages: [
                    ...sent,
                    { role: 'assistant', content: reply },
                    { role: 'user', content: 'continue' },
                  ],
                  newThread: false,
                  fresh: false,
                  reasoningEffort,
                  webSearch,
                  signal: req.signal,
                }),
              pipeline,
            )
            outcome = {}
            // The continue is a real upstream prompt, so it counts too.
            active.turnCount = (active.turnCount || 0) + 1
            reply += await streamHandler(next, active, pipeline, outcome)
          }
          if (outcome.error) pipeline.emitText('\n\n⚠ Stream error: ' + outcome.error + '\n')

          if (reply) {
            active.parentId = randomId()
            thread.messages = [...sent, { role: 'assistant', content: reply }]
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

module.exports = { buildInceptionRouter, withRetry }
