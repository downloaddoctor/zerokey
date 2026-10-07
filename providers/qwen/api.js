const crypto = require('crypto')

const { humanDelay } = require('../../utils/human-delay')
const { uuid } = require('../../utils/uuid')
const { reasoning } = require('./config')

// O(1) reasoning_effort → feature_config lookup
const QWEN_REASONING_MAP = reasoning.map

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

const { BaseAPI } = require('../base/BaseAPI')
const { assertOk } = require('../../utils/http-error')

class QwenAPI extends BaseAPI {
  static BASE_URL = QWEN_AI_BASE

  constructor(options = {}) {
    super(options)
    this._body = {}
  }

  static JSON_TIMEOUT = true

  async initializeFromJSON({ headers, body }) {
    await super.initializeFromJSON({ headers })
    this._body = { ...(body || {}) }

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

    if (!res.ok) throw await this._buildQwenError(res)

    const id = res.data?.data?.id
    if (!id) {
      const snippet = JSON.stringify(res.data ?? null).slice(0, 300)
      throw new Error(
        `[Qwen] createChatSession: no chat id returned (HTTP ${res.status}) ${snippet}`,
      )
    }

    if (this._log) console.debug('[Qwen] Created chat:', id)
    return id
  }

  /**
   * Upload a file/image (HAR flow): POST /api/v2/files/getstsToken returns
   * temporary OSS credentials, the bytes are PUT straight to Alibaba OSS with an
   * OSS4-HMAC-SHA256 header signature, and the returned descriptor goes into
   * message.files[] of the completion request.
   *
   * @param {{ filename: string, data: Buffer, mimeType?: string }} file
   */
  async uploadFile(file) {
    const { filename, data, mimeType = 'application/octet-stream' } = file
    const filetype = mimeType.startsWith('image/') ? 'image' : 'file'

    const stsRes = await this._fetch(
      `${QWEN_AI_BASE}/api/v2/files/getstsToken`,
      {
        method: 'POST',
        headers: this._buildHeaders({
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({ filename, filesize: String(data.length), filetype }),
      },
      true,
    )
    await assertOk(stsRes, { prefix: '[Qwen] getstsToken: ' })

    const sts = stsRes.data?.data
    if (!sts?.access_key_id || !sts?.security_token || !sts?.file_path || !sts?.file_id) {
      throw new Error(
        `[Qwen] getstsToken: unexpected response ${JSON.stringify(stsRes.data).slice(0, 300)}`,
      )
    }

    // OSS V4 header signing (scope region has no 'oss-' prefix).
    const region = String(sts.region || 'oss-ap-southeast-1').replace(/^oss-/, '')
    const host = `${sts.bucketname}.${sts.endpoint}`
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '')
    const day = timestamp.slice(0, 8)
    const encodedKey = sts.file_path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    const signed = {
      'content-type': mimeType,
      'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
      'x-oss-date': timestamp,
      'x-oss-security-token': sts.security_token,
    }
    const canonicalHeaders = Object.keys(signed)
      .sort()
      .map((name) => `${name}:${String(signed[name]).trim()}\n`)
      .join('')
    const canonicalRequest = [
      'PUT',
      `/${sts.bucketname}/${encodedKey}`,
      '',
      canonicalHeaders,
      '',
      'UNSIGNED-PAYLOAD',
    ].join('\n')
    const scope = `${day}/${region}/oss/aliyun_v4_request`
    const stringToSign = [
      'OSS4-HMAC-SHA256',
      timestamp,
      scope,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n')
    const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest()
    const signingKey = hmac(
      hmac(hmac(hmac(`aliyun_v4${sts.access_key_secret}`, day), region), 'oss'),
      'aliyun_v4_request',
    )
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex')

    const putRes = await this._fetch(
      `https://${host}/${encodedKey}`,
      {
        method: 'PUT',
        headers: {
          ...signed,
          authorization: `OSS4-HMAC-SHA256 Credential=${sts.access_key_id}/${scope},Signature=${signature}`,
          origin: QWEN_AI_BASE,
          referer: `${QWEN_AI_BASE}/`,
        },
        body: data,
      },
      false,
    )
    await assertOk(putRes, { prefix: '[Qwen] OSS upload: ' })

    if (this._log)
      console.debug(`[Qwen] File uploaded: ${filename} (${data.length} bytes) → ${sts.file_id}`)

    const now = Date.now()
    return {
      type: filetype,
      file: {
        created_at: now,
        data: {},
        filename,
        hash: null,
        id: sts.file_id,
        user_id: sts.file_path.split('/')[0],
        meta: { name: filename, size: data.length, content_type: mimeType },
        update_at: now,
        name: filename,
        size: data.length,
        type: mimeType,
      },
      id: sts.file_id,
      url: sts.file_url,
      name: filename,
      collection_name: '',
      progress: 0,
      status: 'uploaded',
      greenNet: 'success',
      size: data.length,
      error: '',
      itemId: uuid(),
      file_type: mimeType,
      showType: filetype,
      file_class: filetype === 'image' ? 'vision' : 'document',
      uploadTaskId: uuid(),
    }
  }

  async chatCompletion(chatSessionId, prompt, parentMessageId = null, options = {}) {
    await humanDelay()
    const modelId = options.model || 'qwen3.7-plus'
    const reasoningEffort = options.reasoningEffort || 'Auto'

    if (this._log) {
      console.debug('[PROMPT] REQ', {
        chatSessionId,
        parentMessageId,
        prompt,
        promptLength: prompt.length,
        reasoningEffort,
      })
    }

    const fid = uuid()
    const childId = uuid()
    const ts = Math.floor(Date.now() / 1000)

    // Get reasoning config from map, fallback to Auto
    const reasoningConfig = QWEN_REASONING_MAP[reasoningEffort] || QWEN_REASONING_MAP.Auto

    const featureConfig = {
      thinking_enabled: reasoningConfig.thinking_enabled,
      output_schema: 'phase',
      research_mode: 'normal',
      auto_thinking: reasoningConfig.auto_thinking,
      thinking_mode: reasoningConfig.thinking_mode,
      ...(reasoningConfig.thinking_format && { thinking_format: reasoningConfig.thinking_format }),
      auto_search: reasoningConfig.auto_search,
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
          files: options.files || [],
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
      const text = await res.text().catch((caughtErr) => {
        console.error('res.text() failed:', caughtErr)
        return ''
      })
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch (caughtErr) {
        console.error('JSON.parse() failed:', caughtErr)
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
    const errText = await res.text().catch((caughtErr) => {
      console.error('res.text() failed:', caughtErr)
      return ''
    })
    let parsed = null
    try {
      parsed = JSON.parse(errText)
    } catch (caughtErr) {
      console.error('JSON.parse() failed:', caughtErr)
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

  async selectMessage(chatSessionId, responseId) {
    if (!chatSessionId || !responseId) return
    try {
      await this._fetch(
        `${QWEN_AI_BASE}/api/v2/chats/${chatSessionId}/messages/select`,
        {
          method: 'POST',
          headers: this._buildHeaders({ accept: 'application/json, text/plain, */*' }),
          body: JSON.stringify({ ids: [responseId] }),
        },
        false,
      )
    } catch (caughtErr) {
      console.error('this._fetch() failed:', caughtErr)
      // non-critical — ignore failures
    }
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

    await assertOk(res, { allow: [404], prefix: 'Qwen deleteSession ' })
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

    await assertOk(res, { prefix: '[Qwen] getCurrentUser: ' })

    // Auths response carries a refreshed JWT — keep it in-memory for this
    // process so later requests use a fresh token (never persisted).
    if (res.data?.token) {
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
}

module.exports = { QwenAPI }
