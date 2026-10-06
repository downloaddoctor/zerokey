'use strict'

const express = require('express')

const { StreamPipeline } = require('../../engine/pipeline')
const { ChatGPTAPI } = require('./api')
const { chatgptStreamHandler } = require('./stream-handler')
const { acquireSlot } = require('../../utils/rate-limiter')
const retry = require('../../utils/retry')
const recovery = require('./recovery')
const { runToolLoop } = require('../../core/mhi/loop')
const { CONFIG } = require('../../config/constants')

const chatgptApi = new ChatGPTAPI()
chatgptApi._providerKey = 'chatgpt'

async function buildChatGPTRouter(parsedFetch, session) {
  console.debug('[ChatGPT] Initializing from parsed capture JSON')
  await chatgptApi.initializeFromJSON(parsedFetch)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const pipeline = new StreamPipeline(res, session, 'chatgpt', req.surface, req.isRealSession)

    if (pipeline.ephemeralMode) {
      pipeline.onFinalChunk = () => {
        if (pipeline.session.id) {
          chatgptApi.deleteSession(pipeline.session.id).catch((caughtErr) => {
            console.error('chatgptApi.deleteSession() failed:', caughtErr)
          })
        }
      }
      pipeline.sendFinalChunk()
      return
    }

    const activeSession = pipeline.session
    const model = activeSession.model || 'auto'

    // Defer the SSE [DONE] until the tool loop resolves.
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
          const attachments = []
          pipeline.bindUploader(chatgptApi, attachments)

          const { prompt, handled } = await pipeline.setup(payload.messages, payload.tools, req)
          if (handled) return { assistantText: '' }

          pipeline.beginTurn()
          await recovery.refreshSentinelSafe(chatgptApi)

          const stream = await withRetry(
            () =>
              recovery.withConversationRecovery(activeSession, () =>
                recovery.withAuthRecovery(chatgptApi, () =>
                  chatgptApi.chatCompletion(
                    prompt,
                    activeSession.id,
                    activeSession.parentId,
                    model,
                    attachments,
                  ),
                ),
              ),
            pipeline,
          )
          await chatgptStreamHandler(stream, activeSession, pipeline)
          return { assistantText: pipeline.assistantText }
        },
      })
      pipeline.flushFinish()
    } catch (error) {
      console.error('runToolLoop() failed:', error)
      if (pipeline.deferFinish) {
        pipeline.deferFinish = false
        pipeline._finished = false
      }
      return pipeline.onError(error)
    }
  })

  return router
}

/**
 * Bounded retry around the initial POST only. Stream-level recovery lives in
 * the stream handler. 429 and 403-unusual-activity are handled inside
 * chatgptApi via the rate-limiter cooldown, and classify as terminal here so
 * the router does not hammer a cooled-down provider.
 */
async function withRetry(fn, pipeline) {
  let attempt = 0
  for (;;) {
    attempt += 1
    await acquireSlot('ChatGPT')
    try {
      return await fn()
    } catch (error) {
      console.error('chatgpt router request failed:', error)
      const policy = retry.classify(error, pipeline && pipeline.signal)
      if (!policy.retry || attempt >= policy.maxAttempts) throw error
      retry.discardResponse(error.response)
      const delay = retry.delayMs(attempt, error.response)
      console.warn(
        `[ChatGPT] Retrying after ${policy.kind} (attempt ${attempt + 1}/${policy.maxAttempts}, wait ${delay}ms)`,
      )
      await retry.sleep(delay, pipeline && pipeline.signal)
    }
  }
}

module.exports = { buildChatGPTRouter, withRetry }
