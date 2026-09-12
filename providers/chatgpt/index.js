const { ChatGPTAPI } = require('./api')
const { buildChatGPTRouter } = require('./router')
const { models, reasoning, promptLimit, setupSteps } = require('./config')

module.exports = {
  name: 'chatgpt',
  displayName: 'ChatGPT',
  models,
  reasoning,
  promptLimit,
  setupSteps,
  defaultVision: true,
  createAPI: (options) => new ChatGPTAPI(options),
  validateCredentials: async (parsedFetch) => {
    const api = new ChatGPTAPI()
    await api.initializeFromJSON(parsedFetch)
    try {
      const user = await api.getCurrentUser()
      return { success: true, user: user.name || 'unknown' }
    } catch (error) {
      return { success: false, error: error.message }
    }
  },
  validateFetch: (parsedFetch) => {
    const h = Object.fromEntries(
      Object.entries(parsedFetch.headers).map(([k, v]) => [k.toLowerCase(), v]),
    )
    const b = parsedFetch.body || {}
    const url = parsedFetch.url || ''
    const errors = []
    if (!h['cookie']) errors.push('cookie — required for session auth')
    if (!h['authorization']) errors.push('authorization — required (Bearer token)')
    if (!h['openai-sentinel-proof-token'])
      errors.push(
        'openai-sentinel-proof-token — missing; copy /backend-api/f/conversation, not a /sentinel/ request',
      )
    if (!h['oai-language'])
      errors.push('oai-language — missing; copy from /backend-api/f/conversation request')
    if (!h['oai-device-id'])
      errors.push('oai-device-id — missing; copy from /backend-api/f/conversation request')
    if (!url.endsWith('/backend-api/f/conversation'))
      errors.push('URL must be /backend-api/f/conversation — wrong request copied')
    if (!b['client_contextual_info'])
      errors.push(
        'body.client_contextual_info — missing; copy /backend-api/f/conversation, not /prepare or /sentinel/',
      )
    return errors
  },
  buildRouter: buildChatGPTRouter,
}
