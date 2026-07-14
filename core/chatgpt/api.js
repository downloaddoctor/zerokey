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
  constructor() {
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
      console.log(`[ChatGPT] Seeded cookie jar with ${count} initial cookies`)
    }

    const existingProof = this._headers['openai-sentinel-proof-token']
    if (!existingProof) {
      throw new Error('openai-sentinel-proof-token not found in headers. Data is incomplete.')
    }
    this._config = ChatGPTProofOfWork.decodeProofToken(existingProof)

    const realUA = this._config[4]
    if (realUA && typeof realUA === 'string' && realUA.length > 20) {
      this._headers['user-agent'] = realUA
      console.log('[ChatGPT] Extracted user-agent from proof token:', realUA.slice(0, 60) + '...')
    }

    console.log('[ChatGPT] Loaded from saved JSON')

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

    console.log('[PROMPT] REQ', {
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

    console.log(res.status, res.statusText)

    // Non-200 status is logged here; the error branch below throws for the caller to handle.
    // No automatic sentinel-refresh-and-retry is implemented.
    if (res.status !== 200) {
      console.log(`[ChatGPT] Got ${res.status}`)
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
      console.log(`[ChatGPT] Prepare conversation returned ${res.status}`)
      return
    }

    this._captureResponseHeaders(res)

    const data = await res.json()
    if (data.conduit_token) {
      this._headers['x-conduit-token'] = data.conduit_token
      console.log('[ChatGPT] Conduit token from body for conversation:', conversationId)
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
    // console.log('[ChatGPT] Sentinel refreshed')
  }

  // ─── Response header capture ─────────────────────────────────

  _captureResponseHeaders(res) {
    // Capture all cookies via shared CookieJar
    this._cookies.captureFromFetchHeaders(res.headers, ' ChatGPT')

    const oaiIsUpdate = res.headers.get('x-oai-is-update')
    if (oaiIsUpdate) {
      this._headers['x-oai-is'] = oaiIsUpdate
      // console.log('[ChatGPT] Updated x-oai-is from response header')
    }

    const conduitToken = res.headers.get('x-conduit-token')
    if (conduitToken) {
      this._headers['x-conduit-token'] = conduitToken
      // console.log('[ChatGPT] Updated x-conduit-token from response header')
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
  // Header order matches browser HAR exactly per endpoint.
  // Cloudflare fingerprinting checks header order — must match real browser.

  _buildHeaders(overrides = {}, targetPath = '') {
    const src = this._headers
    const isSentinel = targetPath?.includes('/sentinel/')
    const isPrepare = targetPath?.includes('/conversation/prepare')
    const isConversation = targetPath?.includes('/conversation') && !isPrepare

    // Build ordered list of [name, value] pairs matching HAR line order
    const h = []

    // ── Block 1: Common prefix (all endpoints, exact HAR order) ──
    h.push(['accept', overrides.accept || '*/*'])
    h.push(['accept-encoding', 'gzip, deflate, br, zstd'])
    h.push(['accept-language', src['accept-language'] || 'en-US,en;q=0.9'])
    h.push(['authorization', src['authorization']])

    h.push(['cache-control', 'no-cache'])
    // content-length is set automatically by fetch()
    h.push(['content-type', overrides['content-type'] || 'application/json'])

    // ── Block 1.1: Cookies from jar (last before overrides) ──
    const cookieStr = this._cookies.toString()
    if (cookieStr) {
      h.push(['cookie', cookieStr])
    }

    h.push(['oai-client-build-number', src['oai-client-build-number'] || ''])
    h.push(['oai-client-version', src['oai-client-version'] || ''])
    h.push(['oai-device-id', src['oai-device-id'] || ''])

    // ── Block 2: Conversation-only: echo-logs before language ──
    if (isConversation) {
      h.push(['oai-echo-logs', src['oai-echo-logs'] || ''])
    }

    h.push(['oai-language', src['oai-language'] || 'en-US'])
    h.push(['oai-session-id', src['oai-session-id'] || ''])

    // ── Block 3: Conversation-only: telemetry + sentinel tokens ──
    if (isConversation) {
      h.push(['oai-telemetry', src['oai-telemetry'] || ''])
      if (src['openai-sentinel-chat-requirements-prepare-token']) {
        h.push([
          'openai-sentinel-chat-requirements-prepare-token',
          src['openai-sentinel-chat-requirements-prepare-token'],
        ])
      }
      if (src['openai-sentinel-proof-token']) {
        h.push(['openai-sentinel-proof-token', src['openai-sentinel-proof-token']])
      }
      if (src['openai-sentinel-turnstile-token']) {
        h.push(['openai-sentinel-turnstile-token', src['openai-sentinel-turnstile-token']])
      }
    }

    // ── Block 4: Common continues ──
    h.push(['origin', 'https://chatgpt.com'])
    h.push(['pragma', 'no-cache'])
    h.push(['priority', 'u=1, i'])
    h.push(['referer', src['referer'] || 'https://chatgpt.com/'])
    h.push(['sec-ch-ua', src['sec-ch-ua'] || ''])
    h.push(['sec-ch-ua-mobile', src['sec-ch-ua-mobile'] || '?0'])
    h.push(['sec-ch-ua-platform', src['sec-ch-ua-platform'] || ''])
    h.push(['sec-fetch-dest', 'empty'])
    h.push(['sec-fetch-mode', 'cors'])
    h.push(['sec-fetch-site', 'same-origin'])
    h.push(['user-agent', src['user-agent'] || ''])

    // ── Block 5: Prepare-only: conduit before oai-is ──
    if (isPrepare) {
      h.push(['x-conduit-token', src['x-conduit-token'] || 'no-token'])
    }

    // ── Block 6: x-oai-is (all authenticated) ──
    if (src['x-oai-is']) {
      h.push(['x-oai-is', src['x-oai-is']])
    }

    // ── Block 7: trace-id (prepare + conversation, NOT sentinel) ──
    if (isPrepare || isConversation) {
      h.push(['x-oai-turn-trace-id', src['x-oai-turn-trace-id'] || ''])
    }

    // ── Block 8: Target path/route (all) ──
    if (targetPath) {
      h.push(['x-openai-target-path', targetPath])
      h.push(['x-openai-target-route', targetPath])
    }

    // Convert ordered pairs to object (JS preserves insertion order)
    const base = {}
    for (const [k, v] of h) {
      base[k] = v
    }

    // Apply remaining overrides (except those already consumed)
    const extra = { ...overrides }
    delete extra.accept
    delete extra['content-type']
    Object.assign(base, extra)

    return base
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
