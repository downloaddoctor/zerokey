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
    this._httpAgent = new https.Agent({
      keepAlive: true,
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

    const initialCookie = this._headers.cookie || this._headers.Cookie || ''
    if (initialCookie) {
      const count = this._cookies.seedFromHeader(initialCookie)
      if (count > 0 && this._log) {
        console.debug(`[${this.constructor.name}] Seeded ${count} cookies`)
      }
    }
  }

  _captureResponseHeaders(res) {
    this._cookies.captureFromFetchHeaders(res.headers, ` ${this.constructor.name}`)
    this._headers['cookie'] = this._cookies.toString()
  }

  _buildHeaders(overrides = {}) {
    const cookieStr = this._cookies.toString()
    const h = { ...this._headers }
    h['content-type'] = 'application/json'
    if (cookieStr) h['cookie'] = cookieStr
    Object.assign(h, overrides)
    return h
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
      console.error('BaseAPI: fetch failed for ' + url + ':', err)
      clearTimeout(timer)
      if (err.name === 'AbortError') {
        const error = new Error(`Request timed out after ${timeoutMs / 1000}s`)
        error.status = 504
        error.statusCode = 504
        throw error
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

  async getCurrentUser() {
    throw new Error('Not implemented - override in subclass')
  }
}

module.exports = { BaseAPI }
