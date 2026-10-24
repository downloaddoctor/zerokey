const { TRANSPORT, resolveTransport, createAPI } = require('./transport')
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
  transports: [
    {
      value: 'completion',
      title: 'Completion',
      description: 'REST SSE, works with old and new captures (default)',
    },
    {
      value: 'rpc',
      title: 'RPC',
      description: 'Connect/proto, experimental (blocked on f15 signer)',
    },
  ],
  waitPolicy: {
    label: 'at limit',
    userMessage: (username, resetsAt, mins) =>
      `⚠  User "${username}" is at limit. Resets at ${resetsAt} (~${mins} min).`,
    allMessage: (soonestUser, resetsAt, mins) =>
      `⚠ All Claude users are at their usage limit.\n` +
      `    Soonest reset: "${soonestUser}" at ${resetsAt} (~${mins} min).`,
  },
  TRANSPORT,
  createAPI: (options, parsedFetch) => createAPI(options, parsedFetch),
  validateCredentials: async (parsedFetch) => {
    const api = createAPI({}, parsedFetch)
    await api.initializeFromJSON(parsedFetch)
    try {
      const profile = await api.getCurrentUser()
      return { success: true, user: profile.account?.name || 'unknown' }
    } catch (error) {
      console.error('api.getCurrentUser() failed:', error)
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

    if (resolveTransport(parsedFetch).IS_COMPLETION) {
      // Legacy REST SSE protocol. Accept either the old /completion capture
      // (org in the URL path) or a modern claude.ai fetch (org in the
      // x-organization-uuid header), so users can paste whatever they copied.
      const orgInUrl = /\/organizations\/[a-f0-9-]{36}/i.test(url)
      const orgInHeader = !!(
        h['x-organization-uuid'] || /(?:^|;\s*)lastActiveOrg=[a-f0-9-]{36}/i.test(h['cookie'] || '')
      )
      if (!orgInUrl && !orgInHeader)
        errors.push(
          'no organization id — copy a request that has /organizations/<uuid> or x-organization-uuid',
        )
      return errors
    }

    // Opt-in Connect-RPC StreamTimeline. The org id rides in a header, not the URL.
    if (!h['x-organization-uuid'] && !/\/organizations\/[a-f0-9-]{36}/i.test(url))
      errors.push(
        'x-organization-uuid — missing; copy from the StreamTimeline request on claude.ai',
      )
    return errors
  },
  buildRouter: buildClaudeRouter,
}
