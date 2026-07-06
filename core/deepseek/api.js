const { CookieJar } = require('../../utils/cookie-jar')
const { DeepSeekPOW } = require('./pow')

class DeepSeekAPI {
  static BASE_URL = 'https://chat.deepseek.com/api/v0'

  constructor() {
    this.powSolver = null
    this._cookies = new CookieJar()
    this._headers = {}
  }

  async initialize(headers = {}) {
    this.powSolver = new DeepSeekPOW()
    await this.powSolver.initialize()

    // Store all captured headers for later reuse
    this._headers = { ...headers }

    // Seed cookie jar from initial headers if present
    const initialCookie = headers.cookie || headers.Cookie || ''
    if (initialCookie) {
      const count = this._cookies.seedFromHeader(initialCookie)
      if (count > 0) {
        console.log(`[DeepSeek] Seeded cookie jar with ${count} initial cookies`)
      }
    }
  }

  async createChatSession() {
    try {
      const resp = await this._fetch(
        `${DeepSeekAPI.BASE_URL}/chat_session/create`,
        {
          method: 'POST',
          headers: this._buildHeaders(),
          body: JSON.stringify({ character_id: null }),
        },
        true,
      )

      const body = resp.data
      const id = body.data.biz_data.id || body.data.biz_data.chat_session.id

      console.log('[DeepSeekAPI] NEW SESSION:', id)
      return id
    } catch (error) {
      throw new Error('Failed to create chat session: ' + error.message)
    }
  }

  /**
   * Send a chat completion request. Returns a Web ReadableStream.
   */
  async chatCompletion(
    chatSessionId,
    prompt,
    parentMessageId = null,
    thinkingEnabled = false,
    searchEnabled = false,
    modelType = null,
  ) {
    const challenge = await this._getPowChallenge()
    const powResponse = await this.powSolver.solveChallenge(challenge)

    const jsonData = {
      chat_session_id: chatSessionId,
      parent_message_id: parentMessageId,
      model_type: modelType,
      prompt,
      ref_file_ids: [],
      thinking_enabled: thinkingEnabled,
      search_enabled: searchEnabled,
    }

    console.log('[PROMPT] REQ', {
      chatSessionId,
      parentMessageId,
      prompt,
      promptLength: prompt.length,
    })

    const res = await this._fetch(
      `${DeepSeekAPI.BASE_URL}/chat/completion`,
      {
        method: 'POST',
        headers: this._buildHeaders({ 'x-ds-pow-response': powResponse }),
        body: JSON.stringify(jsonData),
      },
      false,
    )

    if (!res.ok) {
      const errText = await res.text()
      const err = new Error(`DeepSeek HTTP ${res.status}: ${errText.slice(0, 300)}`)
      err.status = res.status
      err.statusCode = res.status
      throw err
    }

    this._captureResponseHeaders(res)

    return res.body
  }

  // ─── Internal ───
  async _getPowChallenge() {
    try {
      const resp = await this._fetch(
        `${DeepSeekAPI.BASE_URL}/chat/create_pow_challenge`,
        {
          method: 'POST',
          headers: this._buildHeaders(),
          body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
        },
        true,
      )
      const body = resp.data
      return body.data.biz_data.challenge
    } catch (error) {
      throw new Error('Failed to get POW challenge: ' + error.message)
    }
  }

  /**
   * Delete all chat sessions server-side (single bulk endpoint).
   */
  async deleteAllSessions() {
    console.log('[DeepSeekAPI] Deleting all sessions...')
    const res = await this._fetch(
      `${DeepSeekAPI.BASE_URL}/chat_session/delete_all`,
      {
        method: 'POST',
        headers: this._buildHeaders(),
        body: null,
      },
      false,
    )

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }

    console.log('[DeepSeekAPI] All sessions deleted successfully')
  }

  // ─── Response header capture ─────────────────────────────────

  _captureResponseHeaders(res) {
    this._cookies.captureFromFetchHeaders(res.headers, ' DeepSeek')
  }

  // ─── Headers builder ─────────────────────────────────────────
  _buildHeaders(overrides = {}) {
    const cookieStr = this._cookies.toString()
    const h = { ...this._headers }

    // Always override these
    h['content-type'] = 'application/json'
    if (cookieStr) h['cookie'] = cookieStr

    // Apply overrides (e.g. pow response)
    Object.assign(h, overrides)

    return h
  }

  // ─── HTTP fetch ───────────────────────────────────────────────

  async _fetch(url, options = {}, parseJSON = false, timeoutMs = 300_000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let res
    try {
      res = await fetch(url, { ...options, redirect: 'follow', signal: controller.signal })
    } catch (err) {
      clearTimeout(timer)
      if (err.name === 'AbortError') {
        const errorObj = {
          error: {
            type: 'request_timeout',
            message: `Request timed out after ${timeoutMs / 1000}s`,
          },
        }
        const te = new Error(JSON.stringify(errorObj))
        te.status = 504
        te.statusCode = 504
        throw te
      }
      throw err
    }
    clearTimeout(timer)

    if (parseJSON && res.ok) {
      this._captureResponseHeaders(res)
      const json = await res.json()
      return { ok: true, status: res.status, data: json }
    }

    return res
  }
}

module.exports = { DeepSeekAPI }
