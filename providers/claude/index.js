const { ClaudeAPI } = require('./api')
const { buildClaudeRouter } = require('./router')
const { models, reasoning, promptLimit, setupSteps } = require('./config')

module.exports = {
  name: 'claude',
  displayName: 'Claude',
  models,
  reasoning,
  promptLimit,
  setupSteps,
  defaultVision: true,
  waitPolicy: {
    label: 'at limit',
    userMessage: (username, resetsAt, mins) =>
      `⚠  User "${username}" is at limit. Resets at ${resetsAt} (~${mins} min).`,
    allMessage: (soonestUser, resetsAt, mins) =>
      `⚠ All Claude users are at their usage limit.\n` +
      `    Soonest reset: "${soonestUser}" at ${resetsAt} (~${mins} min).`,
  },
  createAPI: (options) => new ClaudeAPI(options),
  validateCredentials: async (parsedFetch) => {
    const api = new ClaudeAPI()
    await api.initializeFromJSON(parsedFetch)
    try {
      const profile = await api.getCurrentUser()
      return { success: true, user: profile.account?.name || 'unknown' }
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
    if (!h['anthropic-device-id'])
      errors.push('anthropic-device-id — missing; copy from the /completion request on claude.ai')
    if (!/\/organizations\/[a-f0-9-]{36}/i.test(url))
      errors.push(
        'URL must contain /organizations/<uuid>/chat_conversations — wrong request copied',
      )
    if (!url.endsWith('/completion'))
      errors.push('URL must end in /completion — copy the streaming completion request, not a GET')
    return errors
  },
  buildRouter: buildClaudeRouter,
}
