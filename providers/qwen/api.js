const https = require('https')
const crypto = require('crypto')

const nodeFetch = require('node-fetch')

const { CookieJar } = require('../../utils/cookie-jar')
const { humanDelay } = require('../../utils/human-delay')

const QWEN_AI_BASE = 'https://chat.qwen.ai'

/**
 * Qwen's RateLimited body carries `num` alongside a `template` string that
 * says whether it means minutes or hours (wording varies), e.g.
 * "...wait {{num}} hours..." vs "...wait {{num}} minutes...". Parse the
 * unit from the template text rather than assuming, and return milliseconds.
 * Defaults to minutes if the template doesn't mention a unit (safer
 * under-estimate than assuming hours).
 */
function parseWaitMs(num, template) {
  if (typeof num !== 'number') return null
  const t = (template || '').toLowerCase()
  if (t.includes('hour')) return num * 60 * 60 * 1000
  return num * 60 * 1000
}

function uuid() {
  try {
    return crypto.randomUUID()
  } catch {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }
}

class QwenAPI {
  static BASE_URL = QWEN_AI_BASE

  constructor(options = {}) {
    this._log = options.log !== false
    this._headers = {}
    this._body = {}
    this._cookies = new CookieJar()
    this._httpAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 300000,
    })
  }

  async initializeFromJSON({ headers, body }) {
    this._headers = { ...headers }
    this._body = { ...(body || {}) }

    const initialCookie = headers.cookie || headers.Cookie || ''
    if (initialCookie) {
      const count = this._cookies.seedFromHeader(initialCookie)
      if (count > 0 && this._log) {
        console.debug(`[Qwen] Seeded cookie jar with ${count} initial cookies`)
      }
    }

    if (!this._getBearer()) {
      throw new Error(
        '[Qwen] Missing auth — capture must include a cookie header with a token= value, or an authorization: Bearer header',
      )
    }

    if (this._log) console.debug('[Qwen] Initialized from capture JSON')
  }

  _getBearer() {
    const h = this._headers
    const raw = h.authorization || h.Authorization || ''
    if (raw) {
      return raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw.trim()
    }

    const cookieStr = h.cookie || h.Cookie || ''
    if (cookieStr) {
      for (const part of cookieStr.split(';')) {
        const trimmed = part.trim()
        if (trimmed.startsWith('token=')) {
          return trimmed.slice(6).trim()
        }
      }
    }

    return ''
  }

  async createChatSession(modelId) {
    await humanDelay()
    const res = await this._fetch(
      `${QWEN_AI_BASE}/api/v2/chats/new`,
      {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify({
          title: 'ZeroKey Chat',
          models: [modelId],
          chat_mode: 'normal',
          chat_type: 't2t',
          timestamp: Date.now(),
          project_id: '',
        }),
      },
      true,
    )

    const id = res.data?.data?.id
    if (!id) {
      throw new Error(`[Qwen] createChatSession: no chat id returned (HTTP ${res.status})`)
    }

    if (this._log) console.debug('[Qwen] Created chat:', id)
    return id
  }

  async chatCompletion(chatSessionId, prompt, parentMessageId = null, options = {}) {
    await humanDelay()
    const modelId = options.model || 'qwen3.7-plus'

    if (this._log) {
      console.debug('[PROMPT] REQ', {
        chatSessionId,
        parentMessageId,
        prompt,
        promptLength: prompt.length,
      })
    }

    const fid = uuid()
    const childId = uuid()
    const ts = Math.floor(Date.now() / 1000)

    const modelLower = String(modelId).toLowerCase()
    const enableThinking = options.enableThinking ?? true
    const enableSearch = options.enableSearch ?? true
    void modelLower

    const featureConfig = {
      thinking_enabled: enableThinking,
      output_schema: 'phase',
      research_mode: 'normal',
      auto_thinking: enableThinking,
      thinking_mode: 'Auto',
      thinking_format: 'summary',
      auto_search: enableSearch,
    }

    const payload = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chatId: chatSessionId,
      parentId: parentMessageId || '',
      chat_id: chatSessionId,
      chat_mode: 'normal',
      model: modelId,
      parent_id: parentMessageId || null,
      messages: [
        {
          id: null,
          fid,
          parentId: parentMessageId || null,
          childrenIds: [childId],
          role: 'user',
          content: prompt,
          user_action: 'chat',
          files: [],
          timestamp: ts,
          models: [modelId],
          model: '',
          chat_type: 't2t',
          feature_config: featureConfig,
          extra: { meta: { subChatType: 't2t' } },
          sub_chat_type: 't2t',
          parent_id: parentMessageId || null,
        },
      ],
      timestamp: ts + 1,
    }

    const res = await this._fetch(
      `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${chatSessionId}`,
      {
        method: 'POST',
        headers: this._buildHeaders({
          accept: 'text/event-stream',
          referer: `${QWEN_AI_BASE}/c/${chatSessionId}`,
          'x-accel-buffering': 'no',
        }),
        body: JSON.stringify(payload),
      },
      false,
    )

    if (!res.ok) {
      throw await this._buildQwenError(res)
    }

    // Qwen sometimes returns HTTP 200 with a JSON error body instead of an
    // SSE stream (e.g. daily RateLimited) — content-type won't be
    // text/event-stream in that case, so sniff and convert to a thrown error.
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      const text = await res.text().catch(() => '')
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {
        // not JSON either; fall through to a generic error below
      }

      const dataCode = parsed?.data?.code
      const message = dataCode
        ? `Qwen HTTP 200 (non-stream): ${dataCode} — ${parsed.data.details || ''}`.trim()
        : `Qwen returned non-stream response: ${text.slice(0, 300)}`

      const err = new Error(message)
      err.status = 200
      err.statusCode = 200
      if (dataCode) {
        err.code = dataCode
        err.num = parsed.data.num
        err.details = parsed.data.details
        err.waitMs = parseWaitMs(parsed.data.num, parsed.data.template)
      }
      throw err
    }

    this._captureResponseHeaders(res)
    return res.body
  }

  /**
   * Parse a non-ok Qwen response body for the structured
   * { success:false, data:{ code, details, num, template } } shape and
   * attach the fields onto the thrown Error so utils/errors.js can classify
   * it (e.g. code:'RateLimited' — daily quota). `waitMs` is derived from
   * `num` + `template` (see parseWaitMs — unit varies between responses).
   * Falls back to a plain text error if the body isn't JSON/doesn't match.
   */
  async _buildQwenError(res) {
    const errText = await res.text().catch(() => '')
    let parsed = null
    try {
      parsed = JSON.parse(errText)
    } catch {
      // not JSON, fall through to plain text error
    }

    const dataCode = parsed?.data?.code
    const message = dataCode
      ? `Qwen HTTP ${res.status}: ${dataCode} — ${parsed.data.details || ''}`.trim()
      : `Qwen HTTP ${res.status}: ${errText.slice(0, 300)}`

    const err = new Error(message)
    err.status = res.status
    err.statusCode = res.status
    if (dataCode) {
      err.code = dataCode
      err.num = parsed.data.num
      err.details = parsed.data.details
      err.waitMs = parseWaitMs(parsed.data.num, parsed.data.template)
    }
    return err
  }

  async deleteSession(chatSessionId) {
    if (!chatSessionId) return
    const res = await this._fetch(
      `${QWEN_AI_BASE}/api/v2/chats/${chatSessionId}`,
      {
        method: 'DELETE',
        headers: this._buildHeaders(),
      },
      false,
    )

    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => '')
      throw new Error(`Qwen deleteSession HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
  }

  async getCurrentUser() {
    const res = await this._fetch(
      `${QWEN_AI_BASE}/api/v1/auths/`,
      {
        method: 'GET',
        headers: this._buildHeaders({ accept: 'application/json, text/plain, */*' }),
      },
      true,
    )

    if (!res.ok || !res.data) {
      throw new Error(`[Qwen] getCurrentUser: HTTP ${res.status}`)
    }

    // Auths response carries a refreshed JWT — keep it in-memory for this
    // process so later requests use a fresh token (never persisted).
    if (res.data.token) {
      this._setToken(res.data.token)
    }

    return res.data
  }

  _setToken(jwt) {
    if (!jwt) return
    this._cookies.seedFromHeader(`token=${jwt}`)
    const cookieStr = this._cookies.toString()
    if (cookieStr) this._headers.cookie = cookieStr
    this._headers.authorization = `Bearer ${jwt}`
  }

  _captureResponseHeaders(res) {
    this._cookies.captureFromFetchHeaders(res.headers, ' Qwen')
    const cookieStr = this._cookies.toString()
    if (cookieStr) this._headers.cookie = cookieStr
  }

  _buildHeaders(overrides = {}) {
    const src = this._headers
    const cookieStr = this._cookies.toString() || src.cookie || ''

    const base = {
      accept: src.accept || 'application/json',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': src['accept-language'] || 'en-US,en;q=0.9',
      authorization: `Bearer ${this._getBearer()}`,
      'content-type': 'application/json',
      ...(cookieStr && { cookie: cookieStr }),
      origin: 'https://chat.qwen.ai',
      priority: 'u=1, i',
      referer: src.referer || 'https://chat.qwen.ai/',
      'sec-ch-ua': src['sec-ch-ua'] || '"Chromium";v="148", "Brave";v="148", "Not/A)Brand";v="99"',
      'sec-ch-ua-mobile': src['sec-ch-ua-mobile'] || '?0',
      'sec-ch-ua-platform': src['sec-ch-ua-platform'] || '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'sec-gpc': src['sec-gpc'] || '1',
      source: 'web',
      timezone: src.timezone || new Date().toString(),
      'user-agent':
        src['user-agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      version: src.version || '0.2.91',
      'x-request-id': uuid(),
      ...(src['bx-v'] && { 'bx-v': src['bx-v'] }),
      ...(src['bx-umidtoken'] && { 'bx-umidtoken': src['bx-umidtoken'] }),
      ...(src['bx-ua'] && { 'bx-ua': src['bx-ua'] }),
    }

    return { ...base, ...overrides }
  }

  async _fetch(url, options = {}, parseJSON = false, timeoutMs = 300_000) {
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

module.exports = { QwenAPI }
