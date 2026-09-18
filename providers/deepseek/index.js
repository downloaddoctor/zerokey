const { DeepSeekAPI } = require('./api')
const { getSharedTransport } = require('./browser-transport')
const { buildDeepSeekRouter } = require('./router')
const { models, reasoning, promptLimit, setupSteps } = require('./config')

// Same env switch as router.js — keeps validation and runtime on the same path.
const TRANSPORT = (process.env.DEEPSEEK_TRANSPORT || 'browser').toLowerCase()

module.exports = {
  name: 'deepseek',
  displayName: 'DeepSeek',
  models,
  reasoning,
  promptLimit,
  setupSteps,
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
  validateCredentials: async (parsedFetch) => {
    // Browser transport: no capture needed for auth — the profile holds the JWT.
    // parsedFetch is still accepted (and stored) for DEEPSEEK_TRANSPORT=api.
    const api = TRANSPORT === 'api' ? new DeepSeekAPI() : getSharedTransport()

    try {
      await api.initializeFromJSON(parsedFetch)
      const user = await api.getCurrentUser()
      return { success: true, user: user.data?.user?.username || 'unknown' }
    } catch (error) {
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
