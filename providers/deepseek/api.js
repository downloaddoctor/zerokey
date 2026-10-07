const { BaseAPI } = require('../base/BaseAPI')
const { assertOk } = require('../../utils/http-error')
const { DeepSeekPOW } = require('./pow')
const { humanDelay } = require('../../utils/human-delay')

class DeepSeekAPI extends BaseAPI {
  static BASE_URL = 'https://chat.deepseek.com/api/v0'

  constructor(options = {}) {
    super(options)
    this._powSolver = new DeepSeekPOW()
  }

  async initializeFromJSON({ headers }) {
    await this._powSolver.initialize()
    await super.initializeFromJSON({ headers })
    if (this._log) console.debug('[DEEPSEEK] Initialized from capture JSON')
  }

  async createChatSession() {
    try {
      await humanDelay()
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

      if (body?.code !== 0) {
        const err = new Error(
          `DeepSeek session create failed: ${body?.msg || `code ${body?.code}`}`,
        )
        err.code = 'session_create_failed'
        err.statusCode = body?.code
        throw err
      }

      const bizCode = body.data?.biz_code
      const bizData = body.data?.biz_data

      if (bizCode === 5) {
        const muteUntil = bizData?.mute_until ?? null
        const err = new Error(
          muteUntil
            ? `DeepSeek account suspended until ${new Date(muteUntil * 1000).toLocaleString()}`
            : 'DeepSeek account suspended',
        )
        err.code = 'account_suspended'
        err.muteUntil = muteUntil
        throw err
      }

      if (!bizData) {
        const err = new Error(
          `DeepSeek session create failed: biz_code=${bizCode} biz_msg=${body.data?.biz_msg}`,
        )
        err.code = 'session_create_failed'
        throw err
      }

      return bizData.id || bizData.chat_session?.id
    } catch (error) {
      console.error('humanDelay() failed:', error)
      if (error.code === 'account_suspended' || error.code === 'session_create_failed') throw error
      throw new Error('Failed to create chat session: ' + error.message)
    }
  }

  async chatCompletion(
    chatSessionId,
    prompt,
    parentMessageId = null,
    thinkingEnabled = false,
    searchEnabled = false,
    modelType = null,
    refFileIds = [],
  ) {
    await humanDelay()
    const challenge = await this._getPowChallenge()
    const powResponse = await this._powSolver.solveChallenge(challenge)

    const jsonData = {
      chat_session_id: chatSessionId,
      parent_message_id: parentMessageId,
      model_type: modelType,
      prompt,
      ref_file_ids: refFileIds,
      thinking_enabled: thinkingEnabled,
      search_enabled: searchEnabled,
      action: null,
      preempt: false,
    }

    if (this._log)
      console.debug('[PROMPT] REQ', {
        chatSessionId,
        parentMessageId,
        prompt,
        refFileIds,
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

    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const json = await res.json()
      if (json?.data?.biz_code === 5) {
        const muteUntil = json.data.biz_data?.mute_until ?? null
        const err = new Error(
          muteUntil
            ? `DeepSeek account suspended until ${new Date(muteUntil * 1000).toLocaleString()}`
            : 'DeepSeek account suspended',
        )
        err.code = 'account_suspended'
        err.muteUntil = muteUntil
        throw err
      }
      const errText = JSON.stringify(json)
      const err = new Error(`DeepSeek unexpected response: ${errText.slice(0, 300)}`)
      err.status = res.status
      err.statusCode = res.status
      throw err
    }

    this._captureResponseHeaders(res)

    return res.body
  }

  async uploadFile(file) {
    const challenge = await this._getPowChallenge('/api/v0/file/upload_file')
    const powResponse = await this._powSolver.solveChallenge(challenge)

    const { filename, data, size } = file

    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2)
    const CRLF = '\r\n'
    const header =
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
      `Content-Type: application/octet-stream${CRLF}${CRLF}`
    const footer = `${CRLF}--${boundary}--${CRLF}`

    const bodyBuffer = Buffer.concat([
      Buffer.from(header, 'utf-8'),
      Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8'),
      Buffer.from(footer, 'utf-8'),
    ])

    const uploadHeaders = this._buildHeaders({
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-ds-pow-response': powResponse,
      'x-file-size': String(size),
      'x-model-type': 'default',
      'x-thinking-enabled': '0',
    })

    const res = await this._fetch(
      `${DeepSeekAPI.BASE_URL}/file/upload_file`,
      { method: 'POST', headers: uploadHeaders, body: bodyBuffer },
      true,
    )

    const body = res.data
    if (body.code !== 0 || body.data.biz_code !== 0) {
      throw new Error(`File upload failed: ${body.msg || body.data.biz_msg || 'unknown error'}`)
    }

    const fileId = body.data.biz_data.id
    if (this._log)
      console.debug(`[DEEPSEEK] File uploaded: ${filename} (${size} bytes) → ${fileId}`)

    return this._pollFile(fileId, filename)
  }

  async _pollFile(fileId, _fileName) {
    const maxAttempts = 30
    const delay = 5000

    for (let i = 0; i < maxAttempts; i++) {
      const res = await this._fetch(
        `${DeepSeekAPI.BASE_URL}/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`,
        { method: 'GET', headers: this._buildHeaders() },
        true,
      )

      const body = res.data
      const file = body.data?.biz_data?.files?.[0]
      if (!file) throw new Error(`File ${fileId} not found in fetch_files response`)

      if (file.status === 'SUCCESS') {
        if (this._log)
          console.success(`[DEEPSEEK] File ready: ${fileId} (tokens: ${file.token_usage})`)
        return fileId
      }

      if (file.status === 'ERROR' || file.error_code) {
        throw new Error(`File ${fileId} processing error: ${file.error_code || 'unknown'}`)
      }

      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    throw new Error(`File ${fileId} timed out waiting for processing`)
  }

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
      return resp.data.data.biz_data.challenge
    } catch (error) {
      console.error('this._fetch() failed:', error)
      throw new Error('Failed to get POW challenge: ' + error.message)
    }
  }

  async deleteAllSessions() {
    if (this._log) console.debug('[DEEPSEEK] Deleting all sessions...')
    const res = await this._fetch(
      `${DeepSeekAPI.BASE_URL}/chat_session/delete_all`,
      { method: 'POST', headers: this._buildHeaders(), body: null },
      false,
    )

    await assertOk(res)

    if (this._log) console.debug('[DEEPSEEK] All sessions deleted')
  }

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

    await assertOk(res)
  }

  async getCurrentUser() {
    const res = await this._fetch(
      `${DeepSeekAPI.BASE_URL}/users/current`,
      { method: 'GET', headers: this._buildHeaders() },
      true,
    )

    await assertOk(res, { prefix: 'Failed to get user info: ' })

    return res.data
  }
}

module.exports = { DeepSeekAPI }
