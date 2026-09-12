const registry = require('../providers/registry')

async function buildRouter(selected) {
  const provider = registry.get(selected.provider)
  if (!provider) throw new Error(`Unknown provider: ${selected.provider}`)
  return provider.buildRouter(selected.parsedFetch, selected.session, selected.userData)
}

module.exports = buildRouter
