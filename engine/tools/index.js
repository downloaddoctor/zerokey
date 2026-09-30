// IDE tool-surface registry. Each surface is a configured IDEToolSurface
// instance produced by applying a config function (see ./vscode.js,
// ./copilot.js, ./terax.js, ./opencode.js) to a fresh base instance.
//
// getIDEMapper(ide) is the single entry point consumed by engine/compiler.js.

const { IDEToolSurface } = require('./base')

const CONFIGURATORS = {
  vscode: require('./vscode'),
  copilot: require('./copilot'),
  terax: require('./terax'),
  opencode: require('./opencode'),
}

const cache = {}

/**
 * @param {string} ide - 'vscode' | 'copilot' | 'terax' | 'opencode'
 * @returns {{ tools, reverseMap, rawUser, system, user, tool }}
 */
function getIDEMapper(ide) {
  if (cache[ide]) return cache[ide]

  const configure = CONFIGURATORS[ide]
  if (!configure) throw new Error(`Unknown IDE surface: ${ide}`)

  const surface = new IDEToolSurface()
  configure(surface)

  const resolved = surface.resolve()
  cache[ide] = resolved
  return resolved
}

/**
 * Decide which tool surface a request belongs to by asking every surface
 * whether the system prompt is its own (each declares realSessionPrefix).
 * The Bearer header cannot be trusted for this — VS Code sends 'vscode' for
 * both the classic Copilot Chat and the Copilot SDK surfaces.
 *
 * @param {Array} messages - req.body.messages
 * @returns {string|null} matched surface key, or null when none match
 */
function resolveSurface(messages) {
  const content = messages && messages[0] && messages[0].content
  if (typeof content !== 'string') return null

  for (const [key, configure] of Object.entries(CONFIGURATORS)) {
    const surface = new IDEToolSurface()
    configure(surface)
    if (surface.isRealSession(content)) return key
  }

  return null
}

module.exports = { getIDEMapper, resolveSurface, CONFIGURATORS }
