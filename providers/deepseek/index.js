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
  validateCredentials: async (parsedFetch, username) => {
    // Browser transport: auth = profile dir keyed by local alphanumeric key.
    // localStorage.userToken presence is the only check — no fetch capture,
    // no getCurrentUser() call. parsedFetch is accepted (and stored) only for
    // DEEPSEEK_TRANSPORT=api.
    const api = TRANSPORT === 'api' ? new DeepSeekAPI() : getSharedTransport({ username })

    try {
      await api.initializeFromJSON(parsedFetch)
      return { success: true, user: username }
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
