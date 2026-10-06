// Session classification — thin wrapper over surfaces/, which is the single
// source of truth for IDE tool surfaces. Each surface declares its own
// fingerprints (realSessionPrefix → real IDE turns, utilityPrefixes → IDE-
// internal utility calls like title-gen / progress messages / summarizer), so
// adding a surface automatically registers its signatures; nothing here needs
// updating.
//
// The surface is resolved purely from the request's system prompt — there is
// no header or client-supplied IDE to trust. Priority:
//   1. Real IDE fingerprint (registry.resolveSurface)  → isReal: true
//   2. Utility fingerprint (registry.resolveUtility)   → isReal: false
//   3. No fingerprint: real turn if tools[] (or X-ZeroKey-Tools: 1),
//      otherwise ephemeral; both on the 'openai' surface.

const surfaceRegistry = require('../surfaces/registry')

// The only surface with realSessionPrefix = null — never matched by fingerprint.
const DEFAULT_SURFACE = 'openai'

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
  // IDE-internal utility calls (title-gen, progress messages, summarizer, …)
  // are declared per surface via utilityPrefixes and are always ephemeral,
  // even when they carry tools[]. They must never write into the real session.
  if (surfaceRegistry.resolveUtility(messages)) {
    return { isReal: false, surface: DEFAULT_SURFACE, matched: DEFAULT_SURFACE }
  }
  // No IDE fingerprint and not a utility: a request carrying tools[] (or
  // X-ZeroKey-Tools: 1) is a real openai turn. Anything else is ephemeral.
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
