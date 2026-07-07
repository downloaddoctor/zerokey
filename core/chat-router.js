const { buildChatRouter } = require('../routes/deepseek')
const { buildClaudeRouter } = require('../routes/claude')
const { buildChatGPTRouter } = require('../routes/chatgpt')

/**
 * Manages the active chat router with hot-swap support.
 * Owns mount and the dispatcher middleware.
 */
class ChatRouter {
  constructor(selector) {
    this._selector = selector
    this._router = null
    this._selected = null
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
      router = await buildClaudeRouter(selected.parsedFetch, selected.session, selected.userData)
    } else {
      router = await buildChatRouter(selected.parsedFetch.headers, selected.session)
    }
    this._router = router
    this._selected = selected
    console.log(
      `\n[ChatRouter] ✅ Active: ${selected.user} - ${selected.provider} - ${selected.sessionName}\n`,
    )
  }
}

module.exports = { ChatRouter }
