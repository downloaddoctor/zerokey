const { QwenAPI } = require('./api')
const { buildQwenRouter } = require('./router')
const { models, reasoning, promptLimit, setupSteps } = require('./config')

module.exports = {
  name: 'qwen',
  displayName: 'Qwen',
  models,
  reasoning,
  promptLimit,
  setupSteps,
  defaultVision: false,
  reinjectEvery: 15,
  waitPolicy: {
    label: 'daily_limit',
    userMessage: (username, resetsAt, mins) =>
      `⚠  Account "${username}" hit its daily usage limit, resets at ${resetsAt} (~${mins} min).`,
    allMessage: (soonestUser, resetsAt, mins) =>
      `⚠ All Qwen accounts have hit their daily usage limit.\n` +
      `    Soonest reset: "${soonestUser}" at ${resetsAt} (~${mins} min).`,
  },
  createAPI: (options) => new QwenAPI(options),
  validateCredentials: async (parsedFetch) => {
    const api = new QwenAPI()
    await api.initializeFromJSON(parsedFetch)
    try {
      const user = await api.getCurrentUser()
      return { success: true, user: user.name || user.email || 'qwen-user' }
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
    const cookieStr = h['cookie'] || ''
    const hasTokenCookie = /(?:^|;\s*)token=[^;]+/.test(cookieStr)
    if (!h['authorization'] && !hasTokenCookie) {
      errors.push(
        'token — cookie must contain a `token=<jwt>` value, or an authorization: Bearer header must be present',
      )
    }
    if (!url.includes('/api/v2/chat/completions'))
      errors.push('URL must contain /api/v2/chat/completions — wrong request copied')
    return errors
  },
  buildRouter: buildQwenRouter,
}
