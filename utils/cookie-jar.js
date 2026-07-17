/**
 * Cookie Jar — shared cookie management for all API clients.
 *
 * Stores cookies in a Map keyed by name. Supports:
 *  - Parsing Set-Cookie header strings
 *  - Capturing from fetch-style Headers (getSetCookie API)
 *  - Capturing from raw Node.js http response headers (set-cookie array)
 *  - Serializing to Cookie header string for outgoing requests
 */
class CookieJar {
  constructor() {
    this._jar = new Map()
  }

  /** Parse a single Set-Cookie string into { name, value } */
  parseSetCookie(setCookieStr) {
    if (!setCookieStr) return null
    const eqIdx = setCookieStr.indexOf('=')
    if (eqIdx === -1) return null
    const name = setCookieStr.slice(0, eqIdx).trim()
    const semiIdx = setCookieStr.indexOf(';', eqIdx + 1)
    const value =
      semiIdx === -1
        ? setCookieStr.slice(eqIdx + 1).trim()
        : setCookieStr.slice(eqIdx + 1, semiIdx).trim()
    if (!name) return null
    return { name, value }
  }

  /** Seed jar from a raw Cookie header string (e.g. from initial user paste) */
  seedFromHeader(cookieHeader) {
    if (!cookieHeader) return
    const cookies = cookieHeader.split(';')
    for (const c of cookies) {
      const parsed = this.parseSetCookie(c.trim())
      if (parsed) {
        this._jar.set(parsed.name, parsed.value)
      }
    }
    return this._jar.size
  }

  /** Capture from fetch-style Headers object (getSetCookie + fallback) */
  captureFromFetchHeaders(headers, label = '') {
    const setCookieHeaders = headers.getSetCookie ? headers.getSetCookie() : []

    if (setCookieHeaders.length === 0) {
      const raw = headers.get('set-cookie')
      if (raw) setCookieHeaders.push(raw)
    }

    let count = 0
    for (const header of setCookieHeaders) {
      const parsed = this.parseSetCookie(header)
      if (!parsed) continue
      this._jar.set(parsed.name, parsed.value)
      count++
      // console.debug(`[CookieJar${label}] captured: ${parsed.name}=${parsed.value.slice(0, 20)}...`)
    }

    return count
  }

  /** Capture from raw Node.js http.IncomingMessage headers */
  captureFromRawHeaders(rawHeaders, label = '') {
    const setCookieHeaders = rawHeaders['set-cookie']
    if (!setCookieHeaders) return 0

    const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders]
    let count = 0
    for (const header of cookies) {
      const parsed = this.parseSetCookie(header)
      if (!parsed) continue
      this._jar.set(parsed.name, parsed.value)
      count++
      // console.debug(`[CookieJar${label}] captured: ${parsed.name}=${parsed.value.slice(0, 20)}...`)
    }
    return count
  }

  /** Serialize all stored cookies to a Cookie header value */
  toString() {
    const cookies = []
    for (const [name, value] of this._jar) {
      cookies.push(`${name}=${value}`)
    }
    return cookies.join('; ')
  }

  /** Number of cookies stored */
  get size() {
    return this._jar.size
  }
}

module.exports = { CookieJar }
