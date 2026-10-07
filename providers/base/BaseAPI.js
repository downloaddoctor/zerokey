const https = require('https')
const nodeFetch = require('node-fetch')
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
    // One agent per provider host for the whole server lifetime: sockets stay open
    // between turns, so DNS + TCP + TLS are paid once. 'lifo' reuses the freshest
    // socket, which the server is least likely to have closed while idle.
    this._httpAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      scheduling: 'lifo',
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 300000,
    })
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

  async _fetch(url, options = {}, parseJSON = false, timeoutMs = 300000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let res
    try {
      res = await nodeFetch(url, {
        ...options,
        redirect: 'follow',
        signal: controller.signal,
        agent: this._httpAgent,
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
