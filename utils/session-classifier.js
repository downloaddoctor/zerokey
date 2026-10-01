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

/**
 * Classify a request: which tool surface does it belong to, and is it a real
 * conversational turn?
 *
 * @param {Array} messages - req.body.messages
 * @param {string} [fallback=DEFAULT_SURFACE] - surface for unmatched requests
 * @returns {{ isReal: boolean, surface: string, matched: string|null }}
 */
function classifySession(messages, fallback = DEFAULT_SURFACE) {
  const surface = surfaceRegistry.resolveSurface(messages)
  if (surface) return { isReal: true, surface, matched: surface }

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
