// Session classification — thin wrapper over surfaces/, which is the single
// source of truth for IDE tool surfaces. Each surface declares its own
// system-prompt fingerprint (realSessionPrefix → IDEToolSurface#isRealSession),
// so adding a surface automatically registers its signature; nothing here needs
// updating.
//
// The surface is resolved purely from the request's system prompt — there is no
// header or client-supplied IDE to trust. A request with no IDE fingerprint
// lands on the 'openai' surface: a real turn when it carries tools[] (or
// X-ZeroKey-Tools: 1), otherwise an ephemeral utility call (title-gen,
// summaries) that never touches the real session.

const surfaceRegistry = require('../surfaces/registry')

// The only surface with realSessionPrefix = null — never matched by fingerprint.
const DEFAULT_SURFACE = 'openai'

// IDE-internal utility calls (title-gen, ...) carry no fingerprint and can't be
// tagged with headers, and they may carry tools[] too. They are matched by the
// start of their system prompt and are always ephemeral, never a real turn.
const UTILITY_PREFIXES = [
  'You are an expert in crafting ultra-compact titles',
  'You are an expert in writing short, catchy, and encouraging progress messages',
]

/**
 * Classify a request: which tool surface does it belong to, and is it a real
 * conversational turn?
 *
 * @param {Array} messages - req.body.messages
 * @returns {{ isReal: boolean, surface: string, matched: string|null }}
 */
function classifySession(messages, options = {}) {
  const surface = surfaceRegistry.resolveSurface(messages)
  if (surface) return { isReal: true, surface, matched: surface }
  // No IDE fingerprint: a request carrying tools[] (or X-ZeroKey-Tools: 1) is a
  // real openai turn. Anything else is an ephemeral utility call (title-gen,
  // summaries) and must never write into the real session.
  const first = Array.isArray(messages) ? messages[0] : null
  const content =
    first && first.role === 'system' && typeof first.content === 'string' ? first.content : ''
  if (UTILITY_PREFIXES.some((p) => content.startsWith(p))) {
    return { isReal: false, surface: DEFAULT_SURFACE, matched: DEFAULT_SURFACE }
  }
  const hasTools = Array.isArray(options.tools) && options.tools.length > 0
  const isReal = hasTools || options.forceOpenai === true
  return { isReal, surface: DEFAULT_SURFACE, matched: DEFAULT_SURFACE }
}

/**
 * @param {Array} messages - req.body.messages
 * @returns {boolean} true — every request is a real turn; whether tools run is
 *   decided by the session's toolCalling flag inside engine/pipeline.js
 */
function isRealChatSession(messages) {
  return classifySession(messages).isReal
}

/**
 * @param {Array} messages - req.body.messages
 * @returns {string} the resolved IDE/tool-surface key
 */
function resolveIde(messages) {
  return classifySession(messages).surface
}

module.exports = { isRealChatSession, resolveIde, classifySession, DEFAULT_SURFACE }
