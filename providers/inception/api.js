'use strict'

/**
 * Inception API transport: talks to chat.inceptionlabs.ai/api/chat directly
 * over HTTPS using impit (Rust reqwest with a real Chrome TLS + HTTP/2
 * fingerprint). This bypasses Vercel Security Checkpoint without a browser.
 *
 * - Auth: authless. A fresh x-session-token is minted by GET /api/session
 *   (no credentials needed) and a _vcrr_* bot cookie comes from GET /. Both
 *   are cached; the token is refreshed on 401 and proactively every 20 min.
 * - Wire: the response is the same AI-SDK UI-message SSE that the web UI
 *   consumes (reasoning-delta, text-delta, error, [DONE]), so stream-handler
 *   works unchanged.
 * - Threads: the site is stateless per request. The caller (router) sends
 *   the full message list every turn; this transport just encodes it as the
 *   site expects (messages[].parts[]).
 * - One request per call, no gate: impit is parallel-safe.
 */

const { PassThrough } = require('stream')
const crypto = require('crypto')
const { Impit } = require('impit')

const ORIGIN = 'https://chat.inceptionlabs.ai'
const CHAT_PATH = '/api/chat'
const SESSION_PATH = '/api/session'
const HEAD_TIMEOUT_MS = 90_000
const TOKEN_MAX_AGE_MS = 20 * 60 * 1000
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'

function randomId(len = 16) {
  return crypto
    .randomBytes(Math.ceil(len * 0.75))
    .toString('base64url')
    .slice(0, len)
}

function nowMs() {
  return Date.now()
}

function statusError(status, text) {
  const err = new Error('[Inception/api] chat: HTTP ' + status + ': ' + text)
  err.status = status
  err.statusCode = status
  return err
}

/**
 * Encode a conversation into the site's request body shape.
 * messages: [{ role: user|assistant, content: string, reasoning?: string }]
 * Only user/assistant are meaningful here; the router never sends system or
 * tool messages (it uses the MHI block grammar inside user text).
 */
function buildBody(opts) {
  const source =
    Array.isArray(opts.messages) && opts.messages.length > 0
      ? opts.messages
      : [{ role: 'user', content: String(opts.prompt || '') }]
  const out = source.map((m) => {
    if (m.role === 'assistant') {
      const parts = []
      if (m.reasoning) {
        parts.push({
          type: 'reasoning',
          id: 'reasoning-0',
          text: String(m.reasoning),
          state: 'done',
        })
      }
      parts.push({ type: 'text', text: String(m.content || ''), state: 'done' })
      return { id: m.id || randomId(), role: 'assistant', parts }
    }
    return {
      id: m.id || randomId(),
      role: 'user',
      parts: [{ type: 'text', text: String(m.content || '') }],
    }
  })
  return {
    reasoningEffort: String(opts.reasoningEffort || 'medium').toLowerCase(),
    webSearchEnabled: Boolean(opts.webSearch),
    voiceMode: false,
    timezone: opts.timezone || 'UTC',
    language: opts.language || 'en-US',
    id: opts.chatId || randomId(),
    messages: out,
    trigger: 'submit-message',
  }
}

class InceptionApi {
  constructor(options = {}) {
    this._log = options.log !== false
    this._browser = options.browser || 'chrome'
    this._client = null
    this._token = null
    this._tokenAt = 0
    this._cookie = null
    this._inflightRefresh = null
  }

  async initializeFromJSON() {}

  _ensureClient() {
    if (!this._client) {
      this._client = new Impit({ browser: this._browser, followRedirects: true })
    }
    return this._client
  }

  _tokenStale() {
    return !this._token || nowMs() - this._tokenAt > TOKEN_MAX_AGE_MS
  }

  async _refresh() {
    if (this._inflightRefresh) return this._inflightRefresh
    this._inflightRefresh = (async () => {
      const client = this._ensureClient()
      try {
        const home = await client.fetch(ORIGIN + '/', { method: 'GET' })
        const setCookie = home.headers.get('set-cookie') || ''
        const m = setCookie.match(/_vcrr_[^=]+=[^;]+/)
        if (m) this._cookie = m[0]
        await home.text()
      } catch (err) {
        console.error('inception/api: home fetch failed:', err)
      }
      const sess = await client.fetch(ORIGIN + SESSION_PATH, { method: 'GET' })
      if (sess.status !== 200) {
        const txt = await sess.text()
        throw new Error(
          '[Inception/api] /api/session HTTP ' + sess.status + ': ' + txt.slice(0, 200),
        )
      }
      const j = await sess.json()
      if (!j || !j.token) throw new Error('[Inception/api] /api/session returned no token')
      this._token = j.token
      this._tokenAt = nowMs()
      if (this._log) console.debug('[Inception/api] token refreshed')
    })().finally(() => {
      this._inflightRefresh = null
    })
    return this._inflightRefresh
  }

  async _ensureToken() {
    if (this._tokenStale()) await this._refresh()
  }

  _headers(bodyLen) {
    const h = {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/json',
      'content-length': String(bodyLen),
      origin: ORIGIN,
      referer: ORIGIN + '/',
      'user-agent': USER_AGENT,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'x-session-token': this._token,
    }
    if (this._cookie) h.cookie = this._cookie
    return h
  }

  /**
   * One chat turn. opts: { messages, reasoningEffort, webSearch, chatId, signal }.
   * Resolves to a Readable of the raw SSE bytes once headers arrive (HTTP 200
   * + text/event-stream). Refreshes the token and retries exactly once on 401.
   */
  async chatCompletion(opts) {
    await this._ensureToken()

    const body = JSON.stringify(buildBody(opts))
    const attempt = (tokenOverride) => this._post(body, tokenOverride || this._token, opts.signal)

    let res
    res = await attempt()

    if (res.status === 401 || res.status === 403) {
      await res.text().catch(() => '')
      await this._refresh()
      res = await attempt()
    }

    const ct = res.headers.get('content-type') || ''
    if (res.status !== 200) {
      const txt = await res.text().catch(() => '')
      throw statusError(res.status, txt.replace(/\s+/g, ' ').slice(0, 300))
    }
    if (!ct.includes('text/event-stream') || !res.body) {
      const txt = await res.text().catch(() => '')
      throw statusError(res.status, 'non-SSE: ' + ct + ' ' + txt.slice(0, 200))
    }

    return this._pump(res)
  }

  async _post(body, token, signal) {
    const client = this._ensureClient()
    const headers = this._headers(Buffer.byteLength(body))
    headers['x-session-token'] = token

    const init = {
      method: 'POST',
      headers,
      body,
    }
    if (signal) init.signal = signal

    const timeout = new Promise((_, reject) => {
      const t = setTimeout(
        () => reject(new Error('[Inception/api] no response in ' + HEAD_TIMEOUT_MS + 'ms')),
        HEAD_TIMEOUT_MS,
      )
      t.unref?.()
      if (signal) signal.addEventListener('abort', () => clearTimeout(t), { once: true })
      init._clear = () => clearTimeout(t)
    })

    try {
      const res = await Promise.race([client.fetch(ORIGIN + CHAT_PATH, init), timeout])
      return res
    } finally {
      init._clear?.()
    }
  }

  _pump(res) {
    const out = new PassThrough()
    const reader = res.body.getReader()
    ;(async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value && value.length) out.write(Buffer.from(value))
        }
        out.end()
      } catch (err) {
        console.error('inception/api: stream read failed:', err)
        out.destroy(err)
      }
    })()
    return out
  }

  async close() {}
}

let _shared = null

function getSharedTransport(options = {}) {
  if (!_shared) _shared = new InceptionApi(options)
  return _shared
}

module.exports = { InceptionApi, getSharedTransport, buildBody }
