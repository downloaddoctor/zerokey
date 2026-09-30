// Session classification — thin wrapper over engine/tools, which is the single
// source of truth for IDE tool surfaces. Each surface declares its own
// system-prompt fingerprint (realSessionPrefix → IDEToolSurface#isRealSession),
// so adding a surface automatically registers its signature; nothing here needs
// updating.
//
// The Bearer header (req.ide) names an IDE, but it cannot distinguish the two
// VS Code surfaces (classic Copilot Chat vs Copilot SDK) — both arrive as
// 'vscode'. So the surface is resolved purely from the system prompt.

const { resolveSurface } = require('../engine/tools')

/**
 * Classify a request: which tool surface does it belong to, and is it a real
 * conversational turn?
 *
 * @param {string} ide - req.ide from the Bearer header (fallback only)
 * @param {Array} messages - req.body.messages
 * @returns {{ isReal: boolean, surface: string, matched: string|null }}
 */
function classifySession(ide, messages) {
  const surface = resolveSurface(messages)
  if (surface) return { isReal: true, surface, matched: surface }

  // No surface recognized this system prompt: treat as an ephemeral/utility
  // call (title-gen, tool-optimizer, …) and keep the header's IDE as surface.
  return { isReal: false, surface: ide, matched: null }
}

/**
 * @param {string} ide - req.ide
 * @param {Array} messages - req.body.messages
 * @returns {boolean} true if this looks like a real conversational turn for
 *   a known IDE surface, false if it should be treated as an ephemeral call
 */
function isRealChatSession(ide, messages) {
  return classifySession(ide, messages).isReal
}

/**
 * Resolve the exact tool surface for a request, falling back to `ide` when no
 * known surface matches.
 *
 * @param {string} ide - req.ide from the Bearer header
 * @param {Array} messages - req.body.messages
 * @returns {string} the resolved IDE/tool-surface key
 */
function resolveIde(ide, messages) {
  return classifySession(ide, messages).surface
}

module.exports = { isRealChatSession, resolveIde, classifySession }
