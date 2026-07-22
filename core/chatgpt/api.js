const https = require('https')
const nodeFetch = require('node-fetch')
const crypto = require('crypto')
const { ChatGPTProofOfWork } = require('./pow')
const { CookieJar } = require('../../utils/cookie-jar')

/**
 * ChatGPT API Client
 *
 * User pastes a full fetch() call from browser DevTools.
 * We extract headers + body, reuse all real values.
 *
 * CRITICAL: "Copy as fetch" omits User-Agent (browser adds it automatically).
 * We extract the real UA from the proof token config[4] and add it to every request.
 * Without User-Agent, Cloudflare returns 403.
 */
class ChatGPTAPI {
  constructor(options = {}) {
    this._log = options.log !== false
    this.BASE_URL = 'https://chatgpt.com'
    this._headers = null
    this._bodyTemplate = null
    this._config = null
    this._ready = false
    this._cookies = new CookieJar()
    this._httpAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 300000,
    })
  }

  async initializeFromJSON(data) {
    this._headers = data.headers
    this._bodyTemplate = data.body

    // Seed cookie jar from initial headers
    const initialCookie = this._headers.cookie || this._headers.Cookie || ''
    if (initialCookie) {
      const count = this._cookies.seedFromHeader(initialCookie)
      if (this._log) console.debug(`[ChatGPT] Seeded cookie jar with ${count} initial cookies`)
    }

    const existingProof = this._headers['openai-sentinel-proof-token']
    if (!existingProof) {
      throw new Error('openai-sentinel-proof-token not found in headers. Data is incomplete.')
    }
    this._config = ChatGPTProofOfWork.decodeProofToken(existingProof)

    const realUA = this._config[4]
    if (realUA && typeof realUA === 'string' && realUA.length > 20) {
      this._headers['user-agent'] = realUA
      // if (this._log) console.debug(`[ChatGPT] User-agent: ${realUA.slice(0, 60)}...`)
    }

    if (this._log) console.debug('[ChatGPT] Initialized from capture JSON')

    await this._refreshSentinel()
    this._ready = true
  }

  async chatCompletion(
    prompt,
    chatSessionId,
    parentMessageId = 'client-created-root',
    model = 'auto',
  ) {
    if (!this._ready) throw new Error('Not initialized')

    const messageId = crypto.randomUUID()
    const partialQuery = {
      id: messageId,
      author: { role: 'user' },
      content: { content_type: 'text', parts: [prompt] },
    }

    await this._refreshSentinel()

    // Always prepare conversation before sending — matches browser HAR flow.
    // First turn: gets initial conduit_token. Follow-up turns: gets refreshed conduit_token.
    await this._prepareConversation(chatSessionId, parentMessageId, partialQuery, model)

    const now = Date.now() / 1000

    const body = JSON.parse(JSON.stringify(this._bodyTemplate))
    body.action = 'next'
    body.messages = [
      {
        ...partialQuery,
        create_time: now,
        metadata: {
          selected_github_repos: [],
          selected_all_github_repos: false,
          serialization_metadata: { custom_symbol_offsets: [] },
        },
      },
    ]
    body.conversation_id = chatSessionId
    body.parent_message_id = parentMessageId
    body.client_prepare_state = parentMessageId ? 'success' : 'sent'
    if (body.client_contextual_info) {
      body.client_contextual_info.time_since_loaded =
        (body.client_contextual_info.time_since_loaded || 0) + parseInt(Math.random() * 100)

      this._bodyTemplate.client_contextual_info.time_since_loaded =
        body.client_contextual_info.time_since_loaded
    }

    if (this._log)
      console.debug('[PROMPT] REQ', {
        chatSessionId,
        parentMessageId,
        prompt,
        promptLength: prompt.length,
      })

    const url = `${this.BASE_URL}/backend-api/f/conversation`

    const res = await this._fetch(url, {
      method: 'POST',
      headers: this._buildHeaders({ accept: 'text/event-stream' }, '/backend-api/f/conversation'),
      body: JSON.stringify(body),
    })

    if (this._log) console.debug(res.status, res.statusText)

    // Non-200 status is logged here; the error branch below throws for the caller to handle.
    // No automatic sentinel-refresh-and-retry is implemented.
    if (res.status !== 200) {
      console.error(`[ChatGPT] Got ${res.status}`)
    }

    if (!res.ok) {
      const errText = await res.text()
      const err = new Error(`ChatGPT error ${res.status}: ${errText.slice(0, 300)}`)
      err.status = res.status
      err.statusCode = res.status
      throw err
    }

    this._captureResponseHeaders(res)

    return res.body
  }

  // ─── Conversation prepare (conduit token refresh) ───────────
  // HAR shows this is called before EVERY /f/conversation POST.
  // First call sends "x-conduit-token: no-token". Subsequent calls
  // send the previously returned conduit_token.

  async _prepareConversation(conversationId, parentMessageId, partialQuery, model = 'auto') {
    const url = `${this.BASE_URL}/backend-api/f/conversation/prepare`
    const body = {
      action: 'next',
      fork_from_shared_post: false,
      parent_message_id: parentMessageId || 'client-created-root',
      model: model || 'auto',
      client_prepare_state: partialQuery ? 'success' : 'none',
      partial_query: partialQuery,
      timezone_offset_min: 420,
      timezone: 'America/Los_Angeles',
      conversation_mode: { kind: 'primary_assistant' },
      system_hints: [],
      supports_buffering: true,
      supported_encodings: ['v1'],
      client_contextual_info: { app_name: 'chatgpt.com' },
    }

    if (conversationId) {
      body.conversation_id = conversationId
    }

    const res = await this._fetch(url, {
      method: 'POST',
      headers: this._buildHeaders(
        {
          accept: '*/*',
          'x-conduit-token': this._headers['x-conduit-token'] || 'no-token',
        },
        '/backend-api/f/conversation/prepare',
      ),
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      if (this._log) console.error(`[ChatGPT] Prepare conversation returned ${res.status}`)
      return
    }

    this._captureResponseHeaders(res)

    const data = await res.json()
    if (data.conduit_token) {
      this._headers['x-conduit-token'] = data.conduit_token
      if (this._log)
        console.debug('[ChatGPT] Conduit token from body for conversation:', conversationId)
    }
  }

  // ─── Sentinel refresh ─────────────────────────────────────────

  async _refreshSentinel() {
    if (!this._config) throw new Error('No proof token config for sentinel')

    const sentinelProof = ChatGPTProofOfWork.generateSentinelProof([...this._config])

    const url = `${this.BASE_URL}/backend-api/sentinel/chat-requirements/prepare`
    const res = await this._fetch(url, {
      method: 'POST',
      headers: this._buildHeaders(
        { accept: '*/*', 'content-type': 'application/json' },
        '/backend-api/sentinel/chat-requirements/prepare',
      ),
      body: JSON.stringify({ p: sentinelProof }),
    })

    if (!res.ok) {
      const text = await res.text()
      const err = new Error(`Sentinel ${res.status}: ${text.slice(0, 200)}`)
      err.code = res.status
      err.status = res.status
      err.statusCode = res.status
      throw err
    }

    this._captureResponseHeaders(res)

    const data = await res.json()
    if (!data.prepare_token || !data.proofofwork) {
      throw new Error(`Sentinel unexpected: ${JSON.stringify(data)}`)
    }

    const powProof = ChatGPTProofOfWork.solve(data.proofofwork.seed, data.proofofwork.difficulty, [
      ...this._config,
    ])

    this._headers['openai-sentinel-chat-requirements-prepare-token'] = data.prepare_token
    this._headers['openai-sentinel-proof-token'] = powProof + '~S'
    if (data.turnstile?.dx) {
      this._headers['openai-sentinel-turnstile-token'] = data.turnstile.dx
    }

    // Cookies captured automatically via _captureResponseHeaders → CookieJar
    // console.debug('[ChatGPT] Sentinel refreshed')
  }

  /**
   * Fetch current user info from /backend-api/me.
   * Used to verify session credentials are valid.
   * Returns user profile data on success, throws on failure.
   */
  async getMe() {
    const res = await this._fetch(
      `${this.BASE_URL}/backend-api/me`,
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
    // Capture all cookies via shared CookieJar
    this._cookies.captureFromFetchHeaders(res.headers, ' ChatGPT')

    const oaiIsUpdate = res.headers.get('x-oai-is-update')
    if (oaiIsUpdate) {
      this._headers['x-oai-is'] = oaiIsUpdate
      // console.debug('[ChatGPT] Updated x-oai-is from response header')
    }

    const conduitToken = res.headers.get('x-conduit-token')
    if (conduitToken) {
      this._headers['x-conduit-token'] = conduitToken
      // console.debug('[ChatGPT] Updated x-conduit-token from response header')
    }

    this._headers['cookie'] = this._cookies.toString()
  }

  // ─── Delete conversation ─────────────────────────────────────

  /**
   * Delete a single conversation server-side.
   * @param {string} conversationId - the conversation UUID to delete
   */
  async deleteSession(conversationId) {
    const url = `${this.BASE_URL}/backend-api/conversation/${conversationId}`
    const res = await this._fetch(url, {
      method: 'PATCH',
      headers: this._buildHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ is_visible: false }),
    })

    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
  }

  // ─── Headers ──────────────────────────────────────────────────
  _buildHeaders(overrides = {}, targetPath = '') {
    const src = this._headers
    const isPrepare = targetPath?.includes('/conversation/prepare')
    const isConversation = targetPath?.includes('/conversation') && !isPrepare
    const cookieStr = this._cookies.toString()

    const base = {
      accept: overrides.accept || '*/*',
      'accept-encoding': 'gzip, deflate, br, zstd',
      'accept-language': src['accept-language'] || 'en-US,en;q=0.9',
      authorization: src['authorization'],
      'cache-control': 'no-cache',
      'content-type': overrides['content-type'] || 'application/json',
      ...(cookieStr && { cookie: cookieStr }),
      'oai-client-build-number': src['oai-client-build-number'] || '',
      'oai-client-version': src['oai-client-version'] || '',
      'oai-device-id': src['oai-device-id'] || '',
      ...(isConversation && { 'oai-echo-logs': src['oai-echo-logs'] || '' }),
      'oai-language': src['oai-language'] || 'en-US',
      'oai-session-id': src['oai-session-id'] || '',
      ...(isConversation && {
        'oai-telemetry': src['oai-telemetry'] || '',
        ...(src['openai-sentinel-chat-requirements-prepare-token'] && {
          'openai-sentinel-chat-requirements-prepare-token':
            src['openai-sentinel-chat-requirements-prepare-token'],
        }),
        ...(src['openai-sentinel-proof-token'] && {
          'openai-sentinel-proof-token': src['openai-sentinel-proof-token'],
        }),
        ...(src['openai-sentinel-turnstile-token'] && {
          'openai-sentinel-turnstile-token': src['openai-sentinel-turnstile-token'],
        }),
      }),
      origin: 'https://chatgpt.com',
      pragma: 'no-cache',
      priority: 'u=1, i',
      referer: src['referer'] || 'https://chatgpt.com/',
      'sec-ch-ua': src['sec-ch-ua'] || '',
      'sec-ch-ua-mobile': src['sec-ch-ua-mobile'] || '?0',
      'sec-ch-ua-platform': src['sec-ch-ua-platform'] || '',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': src['user-agent'] || '',
      ...(isPrepare && { 'x-conduit-token': src['x-conduit-token'] || 'no-token' }),
      ...(src['x-oai-is'] && { 'x-oai-is': src['x-oai-is'] }),
      ...((isPrepare || isConversation) && {
        'x-oai-turn-trace-id': src['x-oai-turn-trace-id'] || '',
      }),
      ...(targetPath && {
        'x-openai-target-path': targetPath,
        'x-openai-target-route': targetPath,
      }),
    }

    const extra = { ...overrides }
    delete extra.accept
    delete extra['content-type']

    return { ...base, ...extra }
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

module.exports = { ChatGPTAPI }
