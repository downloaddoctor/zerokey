const { buildChatRouter } = require('../routes/deepseek')
const { buildClaudeRouter } = require('../routes/claude')
const { buildChatGPTRouter } = require('../routes/chatgpt')

/**
 * Manages the active chat router with hot-swap support.
 * Owns mount, triggerSwitch, and the dispatcher middleware.
 */
class ChatRouter {
  constructor(selector) {
    this._selector = selector
    this._router = null
    this._selected = null
    this._switchPending = false
  }

  /**
   * Express middleware — always delegates to current live router.
   */
  middleware() {
    return (req, res, next) => {
      if (this._router) {
        this._router(req, res, next)
      } else {
        res.status(503).json({ error: { message: 'Router not ready', type: 'server_error' } })
      }
    }
  }

  get selected() {
    return this._selected
  }

  async mount(selected) {
    let router
    if (selected.provider === 'chatgpt') {
      router = await buildChatGPTRouter(selected.parsedFetch, selected.session, selected.userData)
    } else if (selected.provider === 'claude') {
      const onSwitch = () => this.triggerSwitch()
      router = await buildClaudeRouter(
        selected.parsedFetch,
        selected.session,
        selected.userData,
        onSwitch,
      )
    } else {
      router = await buildChatRouter(selected.parsedFetch.headers, selected.session)
    }
    this._router = router
    this._selected = selected
    console.log(
      `\n[ChatRouter] ✅ Active: ${selected.user} - ${selected.provider} - ${selected.sessionName}\n`,
    )
  }

  /**
   * Trigger auto-switch to next available Claude user.
   * Safe to call multiple times — guarded by _switchPending.
   */
  triggerSwitch() {
    if (this._switchPending) return
    this._switchPending = true
    this._tryAutoSwitch().finally(() => {
      this._switchPending = false
    })
  }

  async _tryAutoSwitch() {
    if (this._selected.provider !== 'claude') return

    const pendingSummary = this._selected.userData?.lastSummary || null
    if (pendingSummary) delete this._selected.userData.lastSummary

    this._selector.flush()

    const nextSelected = this._selector.switchToNextAvailable(pendingSummary)
    if (!nextSelected) {
      console.warn(
        '[ChatRouter] ⚠ Auto-switch: no available Claude users — staying on current user',
      )
      return
    }

    try {
      await this.mount(nextSelected)
    } catch (err) {
      console.error('[ChatRouter] Auto-switch mount failed:', err.message)
    }
  }
}

module.exports = { ChatRouter }
