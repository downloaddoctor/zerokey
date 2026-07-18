const express = require('express')
const ToolCompiler = require('../lib/engine')

const { DeepSeekAPI } = require('../core/deepseek/api')
const { toOpenAIError } = require('../utils/errors')
const { streamHandler } = require('../core/deepseek/stream-handler')
const { acquireSlot } = require('../utils/rate-limiter')

const deepseekApi = new DeepSeekAPI()

async function buildDeepSeekRouter(parsedFetch, session) {
  console.debug('[Deepseek] Initializing from parsed capture JSON')
  await initDeepSeekAPI(session, parsedFetch.headers)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [] } = req.body
    const toolCalling = session.toolCalling ?? true

    if (!messages || messages.length === 0) {
      return res
        .status(400)
        .json(
          toOpenAIError(
            400,
            'messages is required and must be a non-empty array',
            'invalid_request_error',
            'missing_messages',
          ),
        )
    }

    // Extract and upload files from messages
    const fileIds = []
    const uploadFile = async (f) => fileIds.push(await deepseekApi.uploadFile(f))

    const compiler = new ToolCompiler(req.ide, 'deepseek')
    const isNewSession = session.parentMessageId == null
    const modelType = isNewSession ? session.model || 'expert' : null

    const { dynamicGrammar } = compiler.syncDynamicTools(req.body.tools || [], session)

    let { prompt, skill } = await compiler.formatPrompt(messages, isNewSession, uploadFile)

    if (isNewSession) {
      prompt = toolCalling ? compiler.buildPrompt(prompt, dynamicGrammar) : prompt
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', '*')

    try {
      const parser = new ToolCompiler.Stream(res, 'deepseek', compiler, session)

      if (skill) {
        console.info(
          `[DeepSeek] Skill trigger detected (${skill.triggers[0]}) — bypassing provider API`,
        )
        return ToolCompiler.emitSkill(res, parser, skill)
      }

      await acquireSlot('DeepSeek')
      const deepseekStream = await deepseekApi.chatCompletion(
        session.chatSessionId,
        prompt,
        session.parentMessageId,
        false,
        true,
        modelType,
        fileIds,
      )

      const retry = async () => {
        await acquireSlot('DeepSeek', true)
        return deepseekApi.chatCompletion(
          session.chatSessionId,
          prompt,
          session.parentMessageId,
          false,
          true,
          modelType,
          fileIds,
        )
      }

      streamHandler(res, deepseekStream, session, parser, retry)
    } catch (error) {
      if (res.headersSent) return
      console.error(`[DeepSeek] Route error: ${error.message}`)
      const err = toOpenAIError(error, 'DeepSeek')
      return res.status(err.error.status || 500).json(err)
    }
  })

  return router
}

async function initDeepSeekAPI(session, headers) {
  await deepseekApi.initialize(headers)
  console.debug('[DeepSeek] Initialized from capture JSON')

  if (!session) throw new Error('No session provided')

  if (session.chatSessionId) {
    // console.debug(`[DeepSeek] Session: "${session.name}" (${session.chatSessionId})`)
    return
  }

  const chatSessionId = await deepseekApi.createChatSession()
  session.chatSessionId = chatSessionId
  // console.success(`[DeepSeek] Session created: "${session.name}" (${chatSessionId})`)
}

module.exports = { buildDeepSeekRouter, initDeepSeekAPI }
