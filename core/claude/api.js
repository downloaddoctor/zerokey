const crypto = require('crypto')
const { CookieJar } = require('../../utils/cookie-jar')

/**
 * Generate a UUID v4.
 */
function generateUUID() {
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

/**
 * Claude API Client
 *
 * User pastes a full fetch() call from browser DevTools (or HAR capture).
 * We extract headers + body, reuse all real values in exact HAR order.
 * Header order matters — Cloudflare fingerprints based on it.
 */
class ClaudeAPI {
  static BASE_URL = 'https://claude.ai/api'

  constructor() {
    this._headers = null
    this._orgId = null
    this._cookies = new CookieJar()
  }

  /**
   * Initialize from parsed fetch JSON (HAR-to-capture or _parseFetchDirect format).
   * Stores all headers as-is for later reconstruction in exact HAR order.
   */
  async initializeFromJSON(parsedFetch) {
    this._headers = { ...parsedFetch.headers }

    // Seed cookie jar from initial headers
    const initialCookie = this._headers.cookie || this._headers.Cookie || ''
    if (initialCookie) {
      const count = this._cookies.seedFromHeader(initialCookie)
      console.log(`[Claude] Seeded cookie jar with ${count} initial cookies`)
    } else {
      console.warn('[Claude] WARNING: No cookies in headers! Cloudflare will block.')
    }

    // Extract organization ID from the captured URL
    const url = parsedFetch.url || parsedFetch?.request?.url || ''
    const orgMatch = url.match(/\/organizations\/([a-f0-9-]+)/i)
    if (orgMatch) {
      this._orgId = orgMatch[1]
      console.log(`[Claude] Extracted org ID from URL: ${this._orgId}`)
    } else {
      console.warn('[Claude] WARNING: No org ID found in URL. Will need discovery.')
    }

    console.log('[Claude] Initialized from capture JSON')
  }

  /**
   * Send a chat completion request. Returns a ReadableStream (Web Streams).
   *
   * @param {string} prompt - User's message text
   * @param {string|null} chatSessionId - Existing conversation UUID (null for new)
   * @param {string|null} parentMessageId - UUID of message to reply to
   * @param {string} model - Model identifier (default: claude-sonnet-4-6)
   * @param {Array} tools - Tool definitions array
   */
  async chatCompletion(
    prompt,
    chatSessionId = null,
    parentMessageId = null,
    model = 'claude-sonnet-4-6',
    tools = [],
  ) {
    if (!this._orgId) throw new Error('Organization ID not set')

    // Generate conversation UUID for new conversations (client-side pregen)
    if (!chatSessionId) {
      chatSessionId = generateUUID()
    }

    const humanMessageUuid = generateUUID()
    const assistantMessageUuid = generateUUID()

    const body = {
      prompt,
      timezone: 'America/Los_Angeles',
      personalized_styles: [
        {
          type: 'default',
          key: 'Default',
          name: 'Normal',
          nameKey: 'normal_style_name',
          prompt: 'Normal\n',
          summary: 'Default responses from Claude',
          summaryKey: 'normal_style_summary',
          isDefault: true,
        },
      ],
      locale: 'en-US',
      model,
      tools,
      turn_message_uuids: {
        human_message_uuid: humanMessageUuid,
        assistant_message_uuid: assistantMessageUuid,
      },
      attachments: [],
      files: [],
      sync_sources: [],
      rendering_mode: 'messages',
    }

    // For new conversations (no parentMessageId), include create_conversation_params
    if (parentMessageId) {
      body.parent_message_uuid = parentMessageId
    } else {
      body.create_conversation_params = {
        name: '',
        model,
        include_conversation_preferences: true,
        paprika_mode: null,
        compass_mode: null,
        is_temporary: false,
        enabled_imagine: true,
      }
    }

    const path = `/organizations/${this._orgId}/chat_conversations/${chatSessionId}/completion`

    console.log('[PROMPT] REQ', {
      chatSessionId,
      parentMessageId,
      prompt,
      promptLength: prompt.length,
    })

    const res = await this._fetch(
      `${ClaudeAPI.BASE_URL}${path}`,
      {
        method: 'POST',
        headers: this._buildHeaders({ accept: 'text/event-stream' }, path),
        body: JSON.stringify(body),
      },
      false,
    )

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(errText)
    }

    this._captureResponseHeaders(res)

    return {
      stream: res.body,
      chatSessionId,
    }
  }

  // ─── Response header capture ─────────────────────────────────
  /**
   * Delete an array of chat sessions server-side.
   * @param {Array} sessions - array of session objects with chatSessionId
   */
  async deleteSessions(sessions) {
    if (!this._orgId) throw new Error('Organization ID not set')

    const toDelete = sessions.filter((s) => s.chatSessionId)
    if (toDelete.length === 0) {
      console.log('[ClaudeAPI] No sessions with server IDs to delete')
      return
    }

    console.log(`[ClaudeAPI] Deleting ${toDelete.length} session(s)...`)
    let deleted = 0
    for (const session of toDelete) {
      const url = `${ClaudeAPI.BASE_URL}/organizations/${this._orgId}/chat_conversations/${session.chatSessionId}`
      try {
        const res = await this._fetch(url, {
          method: 'DELETE',
          headers: this._buildHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ uuid: session.chatSessionId }),
        })
        if (res.ok || res.status === 404) {
          deleted++
        } else {
          const text = await res.text().catch(() => '')
          console.warn(
            `[ClaudeAPI] Failed to delete ${session.chatSessionId}: HTTP ${res.status} ${text.slice(0, 100)}`,
          )
        }
      } catch (e) {
        console.warn(`[ClaudeAPI] Error deleting ${session.chatSessionId}: ${e.message}`)
      }
    }
    console.log(`[ClaudeAPI] Sessions deleted: ${deleted}/${toDelete.length}`)
  }

  _captureResponseHeaders(res) {
    // Capture cookies from response
    this._cookies.captureFromFetchHeaders(res.headers, ' Claude')
    // Update stored cookie header for future requests
    this._headers['cookie'] = this._cookies.toString()
  }

  // ─── Headers builder (exact HAR order) ────────────────────────

  /**
   * Build ordered headers matching browser HAR exactly.
   * Cloudflare fingerprints header order — must match real browser.
   */
  _buildHeaders(overrides = {}, targetPath = '') {
    const src = this._headers
    const h = []

    // Block 1: Common prefix — exact HAR order from capture
    h.push(['accept', overrides.accept || '*/*'])
    h.push(['accept-encoding', 'gzip, deflate, br, zstd'])
    h.push(['accept-language', src['accept-language'] || 'en-US,en;q=0.9'])

    // Anthropic client headers
    if (src['anthropic-anonymous-id']) {
      h.push(['anthropic-anonymous-id', src['anthropic-anonymous-id']])
    }
    h.push(['anthropic-client-platform', src['anthropic-client-platform'] || 'web_claude_ai'])
    if (src['anthropic-client-sha']) {
      h.push(['anthropic-client-sha', src['anthropic-client-sha']])
    }
    if (src['anthropic-client-version']) {
      h.push(['anthropic-client-version', src['anthropic-client-version']])
    }
    if (src['anthropic-device-id']) {
      h.push(['anthropic-device-id', src['anthropic-device-id']])
    }

    // content-type
    h.push(['content-type', overrides['content-type'] || 'application/json'])

    // Cookies from jar (critical for Cloudflare)
    const cookieStr = this._cookies.toString()
    if (cookieStr) {
      h.push(['cookie', cookieStr])
    }

    // origin (only for POST)
    if (overrides.accept === 'text/event-stream') {
      h.push(['origin', 'https://claude.ai'])
    }

    // priority
    h.push(['priority', 'u=1, i'])

    // referer
    h.push(['referer', src['referer'] || 'https://claude.ai/chat'])

    // sec-ch-ua (browser fingerprint)
    h.push([
      'sec-ch-ua',
      src['sec-ch-ua'] || '"Chromium";v="148", "Brave";v="148", "Not/A)Brand";v="99"',
    ])
    h.push(['sec-ch-ua-mobile', src['sec-ch-ua-mobile'] || '?0'])
    h.push(['sec-ch-ua-platform', src['sec-ch-ua-platform'] || '"Windows"'])

    // sec-fetch-*
    h.push(['sec-fetch-dest', 'empty'])
    h.push(['sec-fetch-mode', 'cors'])
    h.push(['sec-fetch-site', 'same-origin'])

    // user-agent
    h.push([
      'user-agent',
      src['user-agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    ])

    // Activity session ID (present in GET requests in HAR)
    if (src['x-activity-session-id']) {
      h.push(['x-activity-session-id', src['x-activity-session-id']])
    }

    // Convert ordered pairs to object (JS preserves insertion order)
    const base = {}
    for (const [k, v] of h) {
      base[k] = v
    }

    // Apply remaining overrides
    const extra = { ...overrides }
    delete extra.accept
    delete extra['content-type']
    Object.assign(base, extra)

    return base
  }

  // ─── HTTP fetch ───────────────────────────────────────────────

  async _fetch(url, options = {}, parseJSON = false, timeoutMs = 300_000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let res
    try {
      res = await fetch(url, { ...options, redirect: 'follow', signal: controller.signal })
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

module.exports = { ClaudeAPI }
