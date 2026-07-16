const https = require('https')
const nodeFetch = require('node-fetch')
const { CookieJar } = require('../../utils/cookie-jar')
const { DeepSeekPOW } = require('./pow')

class DeepSeekAPI {
  static BASE_URL = 'https://chat.deepseek.com/api/v0'

  constructor(options = {}) {
    this._log = options.log !== false
    this.powSolver = null
    this._cookies = new CookieJar()
    this._headers = {}
    this._httpAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 300000,
    })
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
      if (count > 0 && this._log) {
        console.debug(`[DeepSeek] Seeded cookie jar with ${count} initial cookies`)
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

      // if (this._log) console.debug(`[DeepSeek] New session: ${id}`)
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
    searchEnabled = true,
    modelType = null,
    refFileIds = [],
  ) {
    const challenge = await this._getPowChallenge()
    const powResponse = await this.powSolver.solveChallenge(challenge)

    const jsonData = {
      chat_session_id: chatSessionId,
      parent_message_id: parentMessageId,
      model_type: modelType,
      prompt,
      ref_file_ids: refFileIds,
      thinking_enabled: thinkingEnabled,
      search_enabled: searchEnabled,
    }

    if (this._log)
      console.debug('[PROMPT] REQ', {
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

  /**
   * Upload a file to DeepSeek. Returns file_id on success.
   * @param {string} fileName
   * @param {Buffer|string} fileContent
   * @param {number} fileSize - bytes
   * @returns {Promise<string>} file_id
   */
  async uploadFile(fileName, fileContent, fileSize) {
    // 1. Get POW challenge for file upload
    const challenge = await this._getPowChallenge('/api/v0/file/upload_file')
    const powResponse = await this.powSolver.solveChallenge(challenge)

    // 2. Build multipart form data
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2)
    const CRLF = '\r\n'
    const header =
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}` +
      `Content-Type: application/octet-stream${CRLF}${CRLF}`
    const footer = `${CRLF}--${boundary}--${CRLF}`

    const bodyBuffer = Buffer.concat([
      Buffer.from(header, 'utf-8'),
      Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent, 'utf-8'),
      Buffer.from(footer, 'utf-8'),
    ])

    // 3. Upload
    const uploadHeaders = this._buildHeaders({
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-ds-pow-response': powResponse,
      'x-file-size': String(fileSize),
      'x-model-type': 'default',
      'x-thinking-enabled': '0',
    })

    const res = await this._fetch(
      `${DeepSeekAPI.BASE_URL}/file/upload_file`,
      {
        method: 'POST',
        headers: uploadHeaders,
        body: bodyBuffer,
      },
      true,
    )

    const body = res.data
    if (body.code !== 0 || body.data.biz_code !== 0) {
      throw new Error(`File upload failed: ${body.msg || body.data.biz_msg || 'unknown error'}`)
    }

    const fileId = body.data.biz_data.id
    if (this._log)
      console.debug(`[DeepSeek] File uploaded: ${fileName} (${fileSize} bytes) → ${fileId}`)

    // 4. Poll until processing completes
    return this._pollFile(fileId, fileName)
  }

  /**
   * Poll file status until SUCCESS.
   * @param {string} fileId
   * @param {string} fileName
   * @returns {Promise<string>} file_id
   */
  async _pollFile(fileId, fileName) {
    const maxAttempts = 30
    const delay = 5000

    for (let i = 0; i < maxAttempts; i++) {
      const res = await this._fetch(
        `${DeepSeekAPI.BASE_URL}/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`,
        {
          method: 'GET',
          headers: this._buildHeaders(),
        },
        true,
      )

      const body = res.data
      const file = body.data?.biz_data?.files?.[0]
      if (!file) throw new Error(`File ${fileId} not found in fetch_files response`)

      if (file.status === 'SUCCESS') {
        if (this._log)
          console.success(`[DeepSeek] File ready: ${fileId} (tokens: ${file.token_usage})`)
        return fileId
      }

      if (file.status === 'ERROR' || file.error_code) {
        throw new Error(`File ${fileId} processing error: ${file.error_code || 'unknown'}`)
      }

      // Still PENDING — wait and retry
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    throw new Error(`File ${fileId} timed out waiting for processing`)
  }

  // ─── Internal ───
  async _getPowChallenge(targetPath = '/api/v0/chat/completion') {
    try {
      const resp = await this._fetch(
        `${DeepSeekAPI.BASE_URL}/chat/create_pow_challenge`,
        {
          method: 'POST',
          headers: this._buildHeaders(),
          body: JSON.stringify({ target_path: targetPath }),
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
    if (this._log) console.debug('[DeepSeek] Deleting all sessions...')
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

    if (this._log) console.debug('[DeepSeek] All sessions deleted')
  }

  /**
   * Delete a single chat session server-side.
   * @param {string} chatSessionId - the session UUID to delete
   */
  async deleteSession(chatSessionId) {
    const res = await this._fetch(
      `${DeepSeekAPI.BASE_URL}/chat_session/delete`,
      {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify({ chat_session_id: chatSessionId }),
      },
      false,
    )

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
  }

  /**
   * Fetch current user info from /api/v0/users/current.
   * Used to verify session credentials are valid.
   * Returns user profile data on success, throws on failure.
   */
  async getCurrentUser() {
    const res = await this._fetch(
      `${DeepSeekAPI.BASE_URL}/users/current`,
      {
        method: 'GET',
        headers: this._buildHeaders(),
      },
      true,
    )

    if (res.status !== 200 || !res.data) {
      throw new Error(`Failed to get user info: HTTP ${res.status}`)
    }

    return res.data
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

module.exports = { DeepSeekAPI }
