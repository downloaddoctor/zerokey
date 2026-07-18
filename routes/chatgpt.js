const express = require('express')
const instructions = require('../lib/engine/instructions')
const { ChatGPTAPI } = require('../core/chatgpt/api')
const { chatgptStreamHandler } = require('../core/chatgpt/stream-handler')
const { toOpenAIError } = require('../utils/errors')
const ToolCompiler = require('../lib/engine')
const { acquireSlot } = require('../utils/rate-limiter')
const { setChatGPTInstructions } = require('../core/chatgpt/set-instructions')

const chatgptApi = new ChatGPTAPI()

async function buildChatGPTRouter(parsedFetch, session, userData = null) {
  console.debug('[ChatGPT] Initializing from parsed capture JSON')
  await chatgptApi.initializeFromJSON(parsedFetch)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [] } = req.body
    const toolCalling = session.toolCalling ?? true
    const model = session.model || 'auto'
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

    const compiler = new ToolCompiler(req.ide, 'chatgpt')
    const isNewSession = session.parentMessageId == null

    const { dynamicGrammar } = compiler.syncDynamicTools(req.body.tools || [], session)

    let { prompt, skill } = await compiler.formatPrompt(messages, isNewSession, () => {})

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', '*')

    const parser = new ToolCompiler.Stream(res, 'chatgpt', compiler, session)

    if (skill) {
      console.info(
        `[ChatGPT] Skill trigger detected (${skill.triggers[0]}) — bypassing provider API`,
      )
      return ToolCompiler.emitSkill(res, parser, skill)
    }

    if (isNewSession && toolCalling) {
      // await setChatGPTInstructions(chatgptApi, userData)
      prompt = instructions.getFull() + '\n\n' + dynamicGrammar + '\n\n' + prompt
    }

    await acquireSlot('ChatGPT')

    try {
      const stream = await chatgptApi.chatCompletion(
        prompt,
        session.chatSessionId,
        session.parentMessageId,
        model,
      )

      chatgptStreamHandler(res, stream, session, parser)
    } catch (error) {
      if (res.headersSent) return
      console.error(`[ChatGPT] Route error: ${error.message}`)
      const err = toOpenAIError(error, 'ChatGPT')
      return res.status(err.error.status || 500).json(err)
    }
  })

  return router
}

module.exports = { buildChatGPTRouter }
