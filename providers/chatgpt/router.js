'use strict'

const express = require('express')

const { StreamPipeline } = require('../../engine/pipeline')
const { ChatGPTAPI } = require('./api')
const { chatgptStreamHandler } = require('./stream-handler')
const { acquireSlot } = require('../../utils/rate-limiter')
const retry = require('../../utils/retry')
const recovery = require('./recovery')

const chatgptApi = new ChatGPTAPI()
chatgptApi._providerKey = 'chatgpt'

async function buildChatGPTRouter(parsedFetch, session) {
  console.debug('[ChatGPT] Initializing from parsed capture JSON')
  await chatgptApi.initializeFromJSON(parsedFetch)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [], tools } = req.body
    const pipeline = new StreamPipeline(res, session, 'chatgpt', req.surface, req.isRealSession)
    const activeSession = pipeline.session
    const model = activeSession.model || 'auto'

    const attachments = []
    pipeline.bindUploader(chatgptApi, attachments)

    const { prompt, handled } = await pipeline.setup(messages, tools, req)
    if (handled) return

    if (pipeline.ephemeralMode) {
      pipeline.onFinalChunk = () => {
        if (activeSession.chatSessionId) {
          chatgptApi.deleteSession(activeSession.chatSessionId).catch(() => {})
        }
      }
    }

    // Refresh sentinel + conduit before the turn. Failure is logged but not
    // fatal: the process may still hold valid tokens, and a hard failure here
    // would mask the real upstream error.
    await recovery.refreshSentinelSafe(chatgptApi)

    try {
      const stream = await withRetry(
        () =>
          recovery.withAuthRecovery(chatgptApi, () =>
            chatgptApi.chatCompletion(
              prompt,
              activeSession.chatSessionId,
              activeSession.parentMessageId,
              model,
              attachments,
            ),
          ),
        pipeline,
      )
      await chatgptStreamHandler(stream, activeSession, pipeline)
    } catch (error) {
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
 *
 * 401 is handled inside the callback by `recovery.withAuthRecovery`, which
 * forces a capture reload and retries exactly once per process. If that
 * retry also fails with 401, the error propagates and `retry.classify`
 * marks it terminal (401 → maxAttempts 1), so the outer loop does not
 * retry it again.
 */
async function withRetry(fn, pipeline) {
  let attempt = 0
  for (;;) {
    attempt += 1
    await acquireSlot('ChatGPT')
    try {
      return await fn()
    } catch (error) {
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
