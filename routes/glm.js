const express = require('express')

const { StreamPipeline } = require('../engine/pipeline')
const { GLMAPI } = require('../core/glm/api')
const instructions = require('../engine/instructions')
const { streamHandler } = require('../core/glm/stream-handler')
const { acquireSlot } = require('../utils/rate-limiter')
const { validateMessages } = require('../utils/route-helpers')

const glmApi = new GLMAPI()

function collectSummary(runOnce, session) {
  let text = ''
  let attempt = 0
  let resolved = false

  return new Promise((resolve) => {
    const finish = () => {
      if (resolved) return
      resolved = true
      resolve(text)
    }

    const start = async () => {
      let stream
      try {
        stream = await runOnce()
      } catch (err) {
        console.warn('[GLM] Summary request failed:', err.message)
        return finish()
      }

      const parser = {
        scan: (chunk) => {
          if (typeof chunk === 'string' && chunk) text += chunk
        },
        emitText: () => {},
        sendFinalChunk: finish,
        onError: finish,
      }

      const retry = async () => {
        if (attempt >= 1) return null
        attempt++
        try {
          await acquireSlot('GLM', true)
        } catch {}
        return runOnce()
      }

      streamHandler(stream, session, parser, retry, null)
    }

    start().catch((err) => {
      console.warn('[GLM] Summary collection crashed:', err.message)
      finish()
    })
  })
}

async function buildGLMRouter(parsedFetch, session) {
  console.debug('[GLM] Initializing from parsed capture JSON')
  await glmApi.initializeFromJSON(parsedFetch || {})

  if (!session) throw new Error('No session provided')

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [], tools } = req.body
    if (!validateMessages(messages, res)) return

    StreamPipeline.setSSEHeaders(res)
    const pipeline = new StreamPipeline(res, session, 'glm', req.ide, messages)
    const activeSession = pipeline.session
    const model = activeSession.model || 'glm-5.3-flash'

    if (!activeSession.messageCount) activeSession.messageCount = 0

    const fileIds = []
    pipeline.bindUploader(glmApi, fileIds)

    const { prompt, handled } = await pipeline.setup(messages, tools, req)
    if (handled) return

    if (pipeline.ephemeralMode) {
      pipeline.onFinalChunk = () => {
        if (activeSession.chatSessionId) {
          glmApi.deleteSession(activeSession.chatSessionId).catch(() => {})
        }
      }
    }

    try {
      await acquireSlot('GLM')

      // Guest quota nears exhaustion (GLM guest = 9 msgs / identity) →
      // summarize the live conversation, respawn a fresh guest identity, then
      // replay the user's turn against the new session with the summary
      // prepended as context.
      if (activeSession.messageCount >= 8) {
        console.warn('[GLM] Guest quota near exhaustion — generating summary and respawning...')

        const summaryPrompt =
          'Please write a concise but complete summary of this entire conversation — so it can be pasted into a fresh session to resume work seamlessly. Include all important context, user requirements, and current progress.'

        const summaryText = await collectSummary(
          () =>
            glmApi.chatCompletion(
              activeSession.chatSessionId,
              summaryPrompt,
              activeSession.parentMessageId,
              false,
              false,
              model,
              fileIds,
            ),
          activeSession,
        )

        if (summaryText) {
          console.debug('[GLM] Summary generated:', summaryText.slice(0, 200) + '...')
        } else {
          console.warn('[GLM] Summary empty — continuing without prior-session context')
        }

        await glmApi._respawnGuestSession()
        activeSession.chatSessionId = ''
        activeSession.parentMessageId = null
        activeSession.messageCount = 0

        const summaryBlock = summaryText
          ? `USER: FIRST MESSAGE: Here is the context from my previous session:\n\n${summaryText}\n\n---\n\n${prompt}`
          : prompt

        const newPrompt = `${instructions.getFull()}\n\nIMPORTANT: Always respond in English.\n\n${summaryBlock}`

        const newStream = await glmApi.chatCompletion(
          activeSession.chatSessionId,
          newPrompt,
          activeSession.parentMessageId,
          false,
          true,
          model,
          fileIds,
        )

        streamHandler(newStream, activeSession, pipeline, null, null)
        return
      }

      activeSession.messageCount++

      const glmStream = await glmApi.chatCompletion(
        activeSession.chatSessionId,
        prompt,
        activeSession.parentMessageId,
        false,
        true,
        model,
        fileIds,
      )

      const retry = async () => {
        await acquireSlot('GLM', true)
        return glmApi.chatCompletion(
          activeSession.chatSessionId,
          prompt,
          activeSession.parentMessageId,
          false,
          true,
          model,
          fileIds,
        )
      }

      const onGuestQuotaExhausted = async () => {
        await acquireSlot('GLM', true)
        await glmApi._respawnGuestSession()
        activeSession.messageCount = 0
        return glmApi.chatCompletion(
          activeSession.chatSessionId,
          prompt,
          activeSession.parentMessageId,
          false,
          true,
          model,
          fileIds,
        )
      }

      streamHandler(glmStream, activeSession, pipeline, retry, onGuestQuotaExhausted)
    } catch (error) {
      return pipeline.onError(error)
    }
  })

  return router
}

module.exports = { buildGLMRouter }
