'use strict'

const express = require('express')

const { StreamPipeline } = require('../../engine/pipeline')
const { ChatGPTAPI } = require('./api')
const { chatgptStreamHandler } = require('./stream-handler')
const { withRetry: sharedWithRetry } = require('../../utils/with-retry')
const recovery = require('./recovery')
const { setChatGPTInstructions } = require('./set-instructions')
const { runToolLoop } = require('../../core/mhi/loop')
const { CONFIG } = require('../../config/constants')

async function buildChatGPTRouter(parsedFetch, session, userData = null) {
  const chatgptApi = new ChatGPTAPI()
  console.debug('[ChatGPT] Initializing from parsed capture JSON')
  await chatgptApi.initializeFromJSON(parsedFetch)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const pipeline = new StreamPipeline(res, session, 'chatgpt', req.surface, req.isRealSession)

    if (pipeline.ephemeralMode) {
      pipeline.sendFinalChunk()
      return
    }

    const activeSession = pipeline.session
    const model = activeSession.model || 'auto'

    if (pipeline.isNewSession && !pipeline.rawMode) {
      await setChatGPTInstructions(chatgptApi, userData, pipeline.toolCalling)
      pipeline.haveInstructionsAPI = true
    }

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
                recovery.withAuthRecovery(
                  chatgptApi,
                  () =>
                    chatgptApi.chatCompletion(
                      prompt,
                      activeSession.id,
                      activeSession.parentId,
                      model,
                      attachments,
                    ),
                  userData,
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
const withRetry = (fn, pipeline) => sharedWithRetry(fn, { pipeline, label: 'ChatGPT' })

module.exports = { buildChatGPTRouter, withRetry }
