const { DeepSeekAPI } = require('./api')
const { buildDeepSeekRouter } = require('./router')
const { models, reasoning, promptLimit, setupSteps } = require('./config')

// Token-threshold reinjection (see engine/pipeline.js setup()): re-inject the
// MHI tools grammar every 250K accumulated tokens, the reminder every 50K.
const REINJECT_AT = [
  { tokens: 250_000, fragment: 'instructions' },
  { tokens: 50_000, fragment: 'reminder' },
]

module.exports = {
  name: 'deepseek',
  displayName: 'DeepSeek',
  models,
  reasoning,
  promptLimit,
  setupSteps,
  reinjectAt: REINJECT_AT,
  defaultVision: true,
  waitPolicy: {
    label: 'suspended',
    userMessage: (username, resetsAt, mins) =>
      `⚠  Account "${username}" is suspended until ${resetsAt} (~${mins} min).`,
    allMessage: (soonestUser, resetsAt, mins) =>
      `⚠ All DeepSeek accounts are suspended.\n` +
      `    Soonest reset: "${soonestUser}" at ${resetsAt} (~${mins} min).`,
  },
  createAPI: (options) => new DeepSeekAPI(options),
  validateCredentials: async (parsedFetch, username) => {
    const api = new DeepSeekAPI()

    try {
      await api.initializeFromJSON(parsedFetch)
      await api.getCurrentUser()
      return { success: true, user: username }
    } catch (error) {
      console.error('deepseek: initializeFromJSON failed:', error)
      return { success: false, error: error.message }
    }
  },
  validateFetch: (parsedFetch) => {
    const h = Object.fromEntries(
      Object.entries(parsedFetch.headers).map(([k, v]) => [k.toLowerCase(), v]),
    )
    const url = parsedFetch.url || ''
    const errors = []
    if (!h['cookie']) errors.push('cookie — required for session auth')
    if (!h['authorization']) errors.push('authorization — required (Bearer token)')
    if (!url.endsWith('/api/v0/chat/completion'))
      errors.push('URL must be /api/v0/chat/completion — wrong request copied')
    return errors
  },
  buildRouter: buildDeepSeekRouter,
}
