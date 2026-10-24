const { Readable } = require('stream')
const { Impit } = require('impit')
const { CookieJar } = require('../../utils/cookie-jar')

/**
 * Base API client with common HTTP, cookie, and error handling logic.
 * Provider-specific APIs extend this class.
 */
class BaseAPI {
  static BASE_URL = ''

  constructor(options = {}) {
    this._log = options.log !== false
    this._cookies = new CookieJar()
    this._headers = {}
    // One impit client per API instance: Chrome TLS/HTTP2 fingerprint plus
    // connection reuse. Redirects are followed; timeouts are enforced per request.
    this._client = new Impit({ browser: 'chrome', followRedirects: true })
  }

  /**
   * Initialize from parsed fetch JSON (HAR capture).
   * Override in subclass to extract provider-specific data.
   */
  async initializeFromJSON(parsedFetch) {
    this._headers = { ...parsedFetch.headers }
    this._seedCookies()
  }

  /** Seed the cookie jar from the captured cookie header. */
  _seedCookies() {
    const initialCookie = this._headers.cookie || this._headers.Cookie || ''
    if (!initialCookie) return
    const count = this._cookies.seedFromHeader(initialCookie)
    if (count > 0 && this._log) {
      console.debug(`[${this.constructor.name}] Seeded ${count} cookies`)
    }
  }

  _captureResponseHeaders(res) {
    this._cookies.captureFromFetchHeaders(res.headers, ` ${this.constructor.name}`)
    const cookieStr = this._cookies.toString()
    if (cookieStr) this._headers['cookie'] = cookieStr
  }

  _buildHeaders(overrides = {}) {
    const cookieStr = this._cookies.toString()
    const h = { ...this._headers }
    h['content-type'] = 'application/json'
    if (cookieStr) h['cookie'] = cookieStr
    Object.assign(h, overrides)
    return h
  }

  /**
   * Error thrown when a request exceeds its timeout. Subclasses that set
   * `static JSON_TIMEOUT = true` get a structured `request_timeout` body in the
   * message, which their completion callers parse as an upstream error.
   */
  _timeoutError(timeoutMs) {
    const message = `Request timed out after ${timeoutMs / 1000}s`
    const error = new Error(
      this.constructor.JSON_TIMEOUT
        ? JSON.stringify({ error: { type: 'request_timeout', message } })
        : message,
    )
    error.status = 504
    error.statusCode = 504
    return error
  }

  /**
   * Normalize request headers for impit: drop null/undefined values and
   * accept-encoding (impit negotiates and decodes compression itself).
   */
  _cleanHeaders(headers = {}) {
    const out = {}
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || v === null) continue
      if (k.toLowerCase() === 'accept-encoding') continue
      out[k] = String(v)
    }
    return out
  }

  /**
   * Node Readable view of a response body (impit returns a WHATWG stream).
   * Chunks are Buffers; destroy() cancels the upstream stream.
   */
  _nodeStream(res) {
    const web = res.body
    if (!web) return Readable.from([], { objectMode: false })
    return Readable.from(
      (async function* () {
        for await (const chunk of web) yield Buffer.from(chunk)
      })(),
      { objectMode: false },
    )
  }

  async _fetch(url, options = {}, parseJSON = false, timeoutMs = 300000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let res
    try {
      res = await this._client.fetch(url, {
        ...options,
        headers: this._cleanHeaders(options.headers),
        timeout: options.timeout === undefined ? timeoutMs : options.timeout,
        signal: controller.signal,
      })
    } catch (err) {
      console.error(`${this.constructor.name}: fetch failed for ${url}:`, err)
      clearTimeout(timer)
      if (err.name === 'AbortError') throw this._timeoutError(timeoutMs)
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

  async getCurrentUser() {
    throw new Error('Not implemented - override in subclass')
  }
}

module.exports = { BaseAPI }
