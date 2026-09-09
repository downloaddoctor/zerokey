const https = require('https')
const crypto = require('crypto')
const nodeFetch = require('node-fetch')
const { CookieJar } = require('../../utils/cookie-jar')

const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb'
const ACCESS_TOKEN_EXPIRES_SECONDS = 3600
const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796'
const BASE_URL = 'https://chatglm.cn/chatglm'

function buildSign() {
  const now = String(Date.now())
  const digits = [...now].map(Number)
  const checksum = (digits.reduce((a, b) => a + b, 0) - digits[digits.length - 2]) % 10
  const timestamp = now.slice(0, -2) + checksum + now.slice(-1)
  const nonce = crypto.randomBytes(16).toString('hex')
  const sign = crypto.createHash('md5').update(`${timestamp}-${nonce}-${SIGN_SECRET}`).digest('hex')
  return { timestamp, nonce, sign }
}

function buildRandomXForwardedFor() {
  let firstOctet
  do {
    firstOctet = Math.floor(Math.random() * 223) + 1
  } while ([10, 127, 169, 172, 192].includes(firstOctet))
  return `${firstOctet}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`
}

class GLMAPI {
  constructor(options = {}) {
    this._log = options.log !== false
    this._cookies = new CookieJar()
    this._headers = {}
    this._refreshToken = null
    this._accessToken = null
    this._accessTokenExpiresAt = 0
    this._assistantId = DEFAULT_ASSISTANT_ID
    this._isGuest = false
    this._httpAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 300000,
    })
  }

  async initializeFromJSON(data) {
    const headers = (data && data.headers) || {}
    this._headers = { ...headers }

    const initialCookie = headers.cookie || headers.Cookie || ''
    if (initialCookie) {
      this._cookies.seedFromHeader(initialCookie)
    }

    const auth = headers.authorization || headers.Authorization || ''
    if (auth.startsWith('Bearer ')) {
      this._refreshToken = auth.slice(7)
    }

    if (!this._refreshToken) {
      this._isGuest = true
      if (this._log) console.debug('[GLM] Guest mode — will fetch guest token on demand')
    }

    if (this._log) console.debug('[GLM] Initialized from capture JSON')
  }

  async _refreshAccessToken() {
    const { timestamp, nonce, sign } = buildSign()
    const url = `${BASE_URL}/user-api/user/refresh`

    const res = await this._fetch(
      url,
      {
        method: 'POST',
        headers: this._buildHeaders(
          {
            authorization: `Bearer ${this._refreshToken}`,
            'x-device-id': crypto.randomBytes(16).toString('hex'),
            'x-nonce': nonce,
            'x-request-id': crypto.randomBytes(16).toString('hex'),
            'x-sign': sign,
            'x-timestamp': timestamp,
          },
          'default',
        ),
        body: '{}',
      },
      true,
    )

    const payload = res.data
    const result = payload.result || {}
    const accessToken = result.access_token
    const newRefreshToken = result.refresh_token

    if (!accessToken) {
      throw new Error(`Failed to refresh GLM access token: ${JSON.stringify(payload)}`)
    }

    this._accessToken = accessToken
    if (newRefreshToken && newRefreshToken !== this._refreshToken) {
      this._refreshToken = newRefreshToken
      if (this._log) console.debug('[GLM] refresh_token updated')
    }
    this._accessTokenExpiresAt = Date.now() + (ACCESS_TOKEN_EXPIRES_SECONDS - 30) * 1000
    return this._accessToken
  }

  async _fetchGuestAccessToken() {
    const { timestamp, nonce, sign } = buildSign()
    const url = `${BASE_URL}/user-api/guest/access`

    const res = await this._fetch(
      url,
      {
        method: 'POST',
        headers: this._buildHeaders(
          {
            'x-device-id': crypto.randomBytes(16).toString('hex'),
            'x-nonce': nonce,
            'x-request-id': crypto.randomBytes(16).toString('hex'),
            'x-sign': sign,
            'x-timestamp': timestamp,
            'content-length': '0',
            referer: 'https://chatglm.cn/',
          },
          'default',
        ),
        body: '',
      },
      true,
    )

    const payload = res.data
    const result = payload.result || {}
    const accessToken = result.access_token
    const refreshToken = result.refresh_token

    if (!accessToken || !refreshToken) {
      throw new Error(`Failed to get GLM guest access token: ${JSON.stringify(payload)}`)
    }

    this._refreshToken = refreshToken
    this._accessToken = accessToken
    this._isGuest = true
    this._accessTokenExpiresAt = Date.now() + (ACCESS_TOKEN_EXPIRES_SECONDS - 30) * 1000
    return this._accessToken
  }

  async _getAccessToken() {
    if (this._accessToken && Date.now() < this._accessTokenExpiresAt) {
      return this._accessToken
    }

    if (this._refreshToken) {
      return this._refreshAccessToken()
    }

    return this._fetchGuestAccessToken()
  }

  async _respawnGuestSession() {
    this._accessToken = null
    this._refreshToken = null
    this._isGuest = true
    return this._fetchGuestAccessToken()
  }

  async createChatSession() {
    return ''
  }

  async chatCompletion(
    chatSessionId,
    prompt,
    parentMessageId = null,
    thinkingEnabled = false,
    searchEnabled = false,
    model = 'glm-5.3-flash',
    refFileIds = [],
  ) {
    const accessToken = await this._getAccessToken()
    const { timestamp, nonce, sign } = buildSign()

    const requestBody = {
      assistant_id: this._assistantId,
      conversation_id: chatSessionId || '',
      project_id: '',
      chat_type: 'user_chat',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt,
            },
          ],
        },
      ],
      meta_data: {
        cogview: { rm_label_watermark: false },
        is_test: false,
        input_question_type: 'xxxx',
        channel: '',
        draft_id: '',
        chat_mode: thinkingEnabled ? 'zero' : '',
        selected_model: model,
        is_networking: searchEnabled,
        quote_log_id: '',
        platform: 'pc',
      },
    }

    if (refFileIds.length > 0) {
      requestBody.messages[0].content = [
        ...refFileIds.map((id) => ({ type: 'file', file: [{ source_id: id }] })),
        ...requestBody.messages[0].content,
      ]
    }

    if (this._log)
      console.debug('[PROMPT] REQ', {
        chatSessionId,
        parentMessageId,
        prompt,
        promptLength: prompt.length,
        isGuest: this._isGuest,
      })

    const url = `${BASE_URL}/backend-api/assistant/stream`

    const res = await this._fetch(
      url,
      {
        method: 'POST',
        headers: this._buildHeaders({
          authorization: `Bearer ${accessToken}`,
          'x-device-id': crypto.randomBytes(16).toString('hex'),
          'x-nonce': nonce,
          'x-request-id': crypto.randomBytes(16).toString('hex'),
          'x-sign': sign,
          'x-timestamp': timestamp,
          accept: 'text/event-stream',
        }),
        body: JSON.stringify(requestBody),
      },
      false,
    )

    if (!res.ok) {
      const errText = await res.text()
      if (res.status === 429) {
        const { setProviderCooldown } = require('../../utils/rate-limiter')
        const cooldownMs = 60_000
        setProviderCooldown('GLM', cooldownMs)
        const err = new Error(`GLM error 429: ${errText.slice(0, 300)}`)
        err.status = 429
        err.statusCode = 429
        err.cooldownMs = cooldownMs
        throw err
      }
      const err = new Error(`GLM error ${res.status}: ${errText.slice(0, 300)}`)
      err.status = res.status
      err.statusCode = res.status
      throw err
    }

    this._captureResponseHeaders(res)

    return res.body
  }

  async uploadFile(file) {
    const { filename, data, mimeType = 'application/octet-stream' } = file
    const accessToken = await this._getAccessToken()
    const { timestamp, nonce, sign } = buildSign()
    const boundary = '----WebKitFormBoundary' + crypto.randomBytes(16).toString('hex')
    const CRLF = '\r\n'
    const header =
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
      `Content-Type: ${mimeType}${CRLF}${CRLF}`
    const footer = `${CRLF}--${boundary}--${CRLF}`

    const bodyBuffer = Buffer.concat([
      Buffer.from(header, 'utf-8'),
      Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8'),
      Buffer.from(footer, 'utf-8'),
    ])

    const url = `${BASE_URL}/backend-api/assistant/file_upload`

    const res = await this._fetch(
      url,
      {
        method: 'POST',
        headers: this._buildHeaders(
          {
            authorization: `Bearer ${accessToken}`,
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'x-device-id': crypto.randomBytes(16).toString('hex'),
            'x-nonce': nonce,
            'x-request-id': crypto.randomBytes(16).toString('hex'),
            'x-sign': sign,
            'x-timestamp': timestamp,
          },
          'default',
        ),
        body: bodyBuffer,
      },
      true,
    )

    const result = res.data.result || {}
    const sourceId = result.source_id
    if (!sourceId) {
      throw new Error(`GLM file upload failed: ${JSON.stringify(res.data)}`)
    }

    if (this._log) console.debug(`[GLM] File uploaded: ${filename} → ${sourceId}`)
    return sourceId
  }

  async deleteSession(conversationId) {
    if (!conversationId) return
    const accessToken = await this._getAccessToken()
    const { timestamp, nonce, sign } = buildSign()

    const url = `${BASE_URL}/backend-api/assistant/conversation/delete`

    const res = await this._fetch(
      url,
      {
        method: 'POST',
        headers: this._buildHeaders(
          {
            authorization: `Bearer ${accessToken}`,
            'x-device-id': crypto.randomBytes(16).toString('hex'),
            'x-nonce': nonce,
            'x-request-id': crypto.randomBytes(16).toString('hex'),
            'x-sign': sign,
            'x-timestamp': timestamp,
          },
          'default',
        ),
        body: JSON.stringify({
          assistant_id: this._assistantId,
          conversation_id: conversationId,
        }),
      },
      true,
    )

    return res.data
  }

  async deleteAllSessions() {}

  async getCurrentUser() {
    const accessToken = await this._getAccessToken()
    const url = `${BASE_URL}/user-api/user/info`

    const res = await this._fetch(
      url,
      {
        method: 'GET',
        headers: this._buildHeaders(
          {
            authorization: `Bearer ${accessToken}`,
          },
          'default',
        ),
      },
      true,
    )

    if (res.status !== 200 || !res.data) {
      throw new Error(`Failed to get GLM user info: HTTP ${res.status}`)
    }

    return res.data
  }

  _captureResponseHeaders(res) {
    this._cookies.captureFromFetchHeaders(res.headers, ' GLM')
  }

  _buildHeaders(overrides = {}, appFr = 'browser_extension') {
    const cookieStr = this._cookies.toString()
    const isDefaultApp = appFr === 'default'
    const h = {
      accept: isDefaultApp ? 'application/json, text/plain, */*' : 'text/event-stream',
      'accept-encoding': isDefaultApp ? 'gzip, deflate' : 'identity',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
      'app-name': 'chatglm',
      'cache-control': 'no-cache',
      'content-type': 'application/json',
      origin: 'https://chatglm.cn',
      pragma: 'no-cache',
      priority: 'u=1, i',
      'sec-ch-ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      'x-app-fr': appFr,
      'x-app-platform': 'pc',
      'x-app-version': '0.0.1',
      'x-device-brand': '',
      'x-device-model': '',
      'x-exp-groups': '',
      'x-lang': 'zh',
      'x-forwarded-for': buildRandomXForwardedFor(),
    }

    if (cookieStr) h.cookie = cookieStr

    Object.assign(h, overrides)

    return h
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
        const te = new Error(`Request timed out after ${timeoutMs / 1000}s`)
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

module.exports = { GLMAPI }
