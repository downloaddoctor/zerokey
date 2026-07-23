const ToolCompiler = require('../lib/engine')
const { setSSEHeaders } = require('./stream-helpers')

/**
 * OpenCode fires two calls on a session's first message: one is a lightweight
 * title-generation utility call (its own fixed system prompt, no session/tool
 * intent), the other is the real conversational turn. Detecting the former
 * lets routes short-circuit before touching any session state, provider
 * rate-limit budget, or the marker/skill pipeline.
 *
 * OpenCode-only — no other IDE currently sends this pattern.
 *
 * @param {string} ide - req.ide
 * @param {Array} messages - req.body.messages
 * @returns {boolean}
 */
function isTitleGenCall(ide, messages) {
  if (ide !== 'opencode') return false
  const first = messages && messages[0]
  return (
    !!first &&
    first.role === 'system' &&
    typeof first.content === 'string' &&
    first.content.startsWith('You are a title generator')
  )
}

/**
 * If `messages` is an OpenCode title-generation call, short-circuits the
 * response with the session's own name (see ToolCompiler.emitTitle) and
 * returns true. Otherwise does nothing and returns false — caller proceeds
 * with its normal request handling.
 *
 * Bypasses the provider entirely: no chatSessionId/parentMessageId/lastUsed
 * mutation, no rate-limit slot, no network round-trip.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} provider - 'deepseek' | 'claude' | 'chatgpt'
 * @param {object} session
 * @returns {boolean} true if the response was handled (caller must return)
 */
function tryEmitTitle(req, res, provider, session) {
  const { messages = [] } = req.body
  if (!isTitleGenCall(req.ide, messages)) return false

  const compiler = new ToolCompiler(req.ide, provider)
  setSSEHeaders(res)
  const parser = new ToolCompiler.Stream(res, provider, compiler, session)
  ToolCompiler.emitTitle(res, parser, withLiveTime(session.name))
  return true
}

/**
 * Appends a human-readable current-time stamp to a title, e.g.
 * 'My Session · Jul 23, 3:45 PM' — so switching between chats shows when
 * each one was last opened, since this fires fresh on every title-gen call.
 *
 * @param {string} name - session.name
 * @returns {string}
 */
function withLiveTime(name) {
  const stamp = new Date().toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return `${name || 'New session'} · ${stamp}`
}

module.exports = { isTitleGenCall, tryEmitTitle }
