// Known system-prompt prefixes each IDE sends on a real conversational turn.
// Fingerprinted from live captures. Anything arriving with a system-first
// message that does NOT start with one of the matching prefixes is not a real
// chat turn — treat it as an ephemeral/utility call (title-gen, tool-optimizer,
// or any other short-lived request not yet individually fingerprinted).
// VS Code sends two distinct prompts: the classic Copilot Chat turn ("You are
// an expert AI programming assistant") and the newer Copilot SDK/agent turn
// ("Follow Microsoft content policies."). Both are real sessions.
const REAL_SESSION_SIGNATURES = {
  opencode: ['You are opencode'],
  terax: ['You are Terax, an AI agent'],
  vscode: ['You are an expert AI programming assistant', 'Follow Microsoft content policies.'],
}

// VS Code Copilot SDK (agent) turns use a distinct system prompt and a
// different native tool surface than classic Copilot Chat (see
// engine/tool-defs.js TOOLS entries under the 'vscode-sdk' key). The Bearer
// header cannot distinguish the two, so resolveIde upgrades req.ide from
// 'vscode' to 'vscode-sdk' when the SDK prompt is detected.
const VSCODE_SDK_SIGNATURE = 'Follow Microsoft content policies.'

/**
 * Shared classifier: decides whether this is a real conversational turn and,
 * for VS Code, whether it is the Copilot SDK variant.
 *
 * @param {string} ide - req.ide from the Bearer header
 * @param {Array} messages - req.body.messages
 * @returns {{ isReal: boolean, isVscodeSdk: boolean }}
 */
function classifySession(ide, messages) {
  const first = messages && messages[0]
  if (!first || first.role !== 'system' || typeof first.content !== 'string') {
    return { isReal: true, isVscodeSdk: false }
  }

  const isVscodeSdk = ide === 'vscode' && first.content.startsWith(VSCODE_SDK_SIGNATURE)

  const sigs = REAL_SESSION_SIGNATURES[ide]
  if (!sigs) return { isReal: true, isVscodeSdk }

  return { isReal: sigs.some((sig) => first.content.startsWith(sig)), isVscodeSdk }
}

/**
 * @param {string} ide - req.ide
 * @param {Array} messages - req.body.messages
 * @returns {boolean} true if this looks like a real conversational turn for
 *   the given IDE, false if it should be treated as an ephemeral utility call
 */
function isRealChatSession(ide, messages) {
  return classifySession(ide, messages).isReal
}

/**
 * Upgrade req.ide for a VS Code Copilot SDK turn: 'vscode' → 'vscode-sdk'.
 * No-op for any other IDE or when messages don't match the SDK prompt.
 *
 * @param {string} ide - req.ide from the Bearer header
 * @param {Array} messages - req.body.messages
 * @returns {string} the resolved IDE key ('vscode-sdk' for SDK turns)
 */
function resolveIde(ide, messages) {
  return classifySession(ide, messages).isVscodeSdk ? 'vscode-sdk' : ide
}

module.exports = { isRealChatSession, resolveIde, classifySession, REAL_SESSION_SIGNATURES }
