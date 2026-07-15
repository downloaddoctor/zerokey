const express = require('express')
const { DeepSeekAPI } = require('../core/deepseek/api')
const { toOpenAIError } = require('../utils/errors')
const { streamHandler } = require('../core/deepseek/stream-handler')
const ToolCompiler = require('../lib/engine')
const { acquireSlot } = require('../utils/rate-limiter')

const deepseekApi = new DeepSeekAPI()

/**
 * Extract files from messages array.
 * Supports:
 *   - content array with { type: 'image_url', image_url: { url: 'data:<mime>;base64,...' } }
 *   - content array with { type: 'file', file: { file_data: 'data:<mime>;base64,...', filename: '...' } }
 * Returns array of { filename, data: Buffer, size: number }
 */
function extractFiles(messages) {
  if (messages.length < 2) return []

  const files = []

  for (let i = messages.length - 2; i >= 0; i--) {
    const msg = messages[i]
    const content = msg.content
    if (!Array.isArray(content)) break

    let found = false
    for (const part of content) {
      if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
        const match = part.image_url.url.match(/^data:([^;]*);base64,(.+)$/)
        if (match) {
          const mime = match[1]
          const data = Buffer.from(match[2], 'base64')
          const ext = mime.split('/')[1] || 'png'
          files.push({
            filename: `image_${Date.now()}_${files.length}.${ext}`,
            data,
            size: data.length,
          })
          found = true
        }
      } else if (part.type === 'file' && part.file?.file_data?.startsWith('data:')) {
        const match = part.file.file_data.match(/^data:([^;]*);base64,(.+)$/)
        if (match) {
          const data = Buffer.from(match[2], 'base64')
          files.push({
            filename: part.file.filename || `file_${Date.now()}_${files.length}`,
            data,
            size: data.length,
          })
          found = true
        }
      }
    }

    if (!found) break
  }

  return files
}

async function buildChatRouter(parsedFetch, session) {
  await initDeepSeekAPI(session, parsedFetch.headers)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [] } = req.body
    const toolCalling = session.toolCalling ?? true
    const modelType = session.model || 'expert'

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
    let refFileIds = []
    const files = extractFiles(messages)
    if (files.length > 0) {
      console.log(`[DeepSeek] Uploading ${files.length} file(s)...`)
      for (const file of files) {
        try {
          const fileId = await deepseekApi.uploadFile(file.filename, file.data, file.size)
          refFileIds.push(fileId)
        } catch (err) {
          console.error(`[DeepSeek] File upload failed: ${err.message}`)
          return res
            .status(400)
            .json(
              toOpenAIError(
                400,
                `File upload failed: ${err.message}`,
                'invalid_request_error',
                'file_upload_failed',
              ),
            )
        }
      }
    }

    const compiler = new ToolCompiler(req.ide, 'deepseek')
    const isNewSession = session.parentMessageId == null

    const { dynamicGrammar } = compiler.syncDynamicTools(req.body.tools || [], session)

    let prompt = compiler.formatPrompt(messages, isNewSession)
    let model_type = null

    if (isNewSession) {
      prompt = toolCalling ? compiler.buildPrompt(prompt, dynamicGrammar) : prompt
      model_type = modelType
    }

    await acquireSlot('DeepSeek')

    try {
      const deepseekStream = await deepseekApi.chatCompletion(
        session.chatSessionId,
        prompt,
        session.parentMessageId,
        false,
        true,
        model_type,
        refFileIds,
      )

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Access-Control-Allow-Origin', '*')

      const parser = new ToolCompiler.Stream(res, 'deepseek', compiler, session)

      const retry = async () => {
        await acquireSlot('DeepSeek', true)
        return deepseekApi.chatCompletion(
          session.chatSessionId,
          prompt,
          session.parentMessageId,
          false,
          true,
          model_type,
          refFileIds,
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
  console.log('[DeepSeek] Initialized from capture JSON')

  if (!session) throw new Error('No session provided')

  if (session.chatSessionId) {
    return console.log(`[DeepSeek] Session: "${session.name}" (${session.chatSessionId})`)
  }

  const chatSessionId = await deepseekApi.createChatSession()
  session.chatSessionId = chatSessionId
  console.log(`[DeepSeek] Session created: "${session.name}" (${chatSessionId})`)
}

module.exports = { buildChatRouter, initDeepSeekAPI }
