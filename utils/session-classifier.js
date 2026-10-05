// Session classification — thin wrapper over surfaces/, which is the single
// source of truth for IDE tool surfaces. Each surface declares its own
// system-prompt fingerprint (realSessionPrefix → IDEToolSurface#isRealSession),
// so adding a surface automatically registers its signature; nothing here needs
// updating.
//
// The surface is resolved purely from the request's system prompt — there is no
// header or client-supplied IDE to trust. `fallback` is used only when no
// surface matches (ephemeral/utility calls), defaulting to 'api' — the no-tool
// surface in surfaces/api.js.

const surfaceRegistry = require('../surfaces/registry')

const DEFAULT_SURFACE = 'api'
// A plain OpenAI client (no IDE system prompt) that carries tools[] is routed
// to the identity-mapped 'openai' surface. It is a real turn (persistent
// session, tool loop enabled) so the MHI executors run without an IDE.
const OPENAI_SURFACE = 'openai'

/**
 * Classify a request: which tool surface does it belong to, and is it a real
 * conversational turn?
 *
 * @param {Array} messages - req.body.messages
 * @param {string} [fallback=DEFAULT_SURFACE] - surface for unmatched requests
 * @param {object} [options]
 * @param {Array}  [options.tools] - req.body.tools[] (any OpenAI tool shape)
 * @param {boolean} [options.forceOpenai] - X-ZeroKey-Tools: 1 header override
 * @returns {{ isReal: boolean, surface: string, matched: string|null }}
 */
function classifySession(messages, fallback = DEFAULT_SURFACE, options = {}) {
  const surface = surfaceRegistry.resolveSurface(messages)
  if (surface) return { isReal: true, surface, matched: surface }

  // No IDE fingerprint. A tools[] array (or the explicit header) means the
  // caller wants tools; route to the identity-mapped 'openai' surface.
  const hasTools = Array.isArray(options.tools) && options.tools.length > 0
  if (hasTools || options.forceOpenai === true) {
    return { isReal: true, surface: OPENAI_SURFACE, matched: OPENAI_SURFACE }
  }

  // No surface recognized this system prompt: treat as an ephemeral/utility
  // call (title-gen, tool-optimizer, …) and use the fallback surface ('api').
  return { isReal: false, surface: fallback, matched: null }
}

/**
 * @param {Array} messages - req.body.messages
 * @param {string} [fallback]
 * @returns {boolean} true if this looks like a real conversational turn for
 *   a known IDE surface, false if it should be treated as an ephemeral call
 */
function isRealChatSession(messages, fallback) {
  return classifySession(messages, fallback).isReal
}

/**
 * Resolve the exact tool surface for a request's messages, falling back to
 * `fallback` when no known surface matches.
 *
 * @param {Array} messages - req.body.messages
 * @param {string} [fallback]
 * @returns {string} the resolved IDE/tool-surface key
 */
function resolveIde(messages, fallback) {
  return classifySession(messages, fallback).surface
}

module.exports = { isRealChatSession, resolveIde, classifySession, DEFAULT_SURFACE }
