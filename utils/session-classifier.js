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
//   2. Utility fingerprint (registry.resolveUtility)   → isReal: false (ephemeral)
//   3. Otherwise: the 'openai' surface, isReal: true
//
// The openai surface is the default for any client that is not an IDE we know
// about (plain OpenAI SDK callers, new IDEs before a fingerprint is declared,
// curl scripts, …). Whether a *tool loop* runs on such a turn is decided by
// the session's toolCalling flag inside engine/pipeline.js, not by the
// presence of tools[] in the request body.

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
function classifySession(messages) {
  const surface = surfaceRegistry.resolveSurface(messages)
  if (surface) return { isReal: true, surface, matched: surface }
  // IDE-internal utility calls (title-gen, progress messages, summarizer, …)
  // are declared per surface via utilityPrefixes and are always ephemeral.
  if (surfaceRegistry.resolveUtility(messages)) {
    return { isReal: false, surface: DEFAULT_SURFACE, matched: DEFAULT_SURFACE }
  }
  // No IDE fingerprint and not a utility: the openai surface, a real turn.
  return { isReal: true, surface: DEFAULT_SURFACE, matched: DEFAULT_SURFACE }
}

/**
 * @param {Array} messages - req.body.messages
 * @returns {boolean} true for real turns and default openai turns, false for
 *   IDE-internal utilities
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
