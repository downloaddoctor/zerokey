const crypto = require('crypto')

const { BaseAPI } = require('../base/BaseAPI')
const { reasoning } = require('./config')
const { humanDelay } = require('../../utils/human-delay')

// O(1) reasoning_effort → { think, tier } lookup.
// Keys are the exact labels VS Code advertises (utils/sync-ide-config.js).
// Anything not mapped disables thinking.
const REASONING_MAP = reasoning.map

/**
 * Generate a UUID v4.
 */
function generateUUID() {
  try {
    return crypto.randomUUID()
  } catch (caughtErr) {
    console.error('crypto.randomUUID() failed:', caughtErr)
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
class ClaudeAPI extends BaseAPI {
  static BASE_URL = 'https://claude.ai/api'

  constructor(options = {}) {
    super(options)
    this._body = {}
    this._orgId = null
  }

  /**
   * Initialize from parsed fetch JSON (HAR-to-capture or _parseFetchDirect format).
   * Stores all headers as-is for later reconstruction in exact HAR order.
   */
  async initializeFromJSON(parsedFetch) {
    await super.initializeFromJSON(parsedFetch)
    this._body = { ...parsedFetch.body }

    // Seed cookie jar from initial headers
    const initialCookie = this._headers.cookie || this._headers.Cookie || ''
    if (!initialCookie && this._log) {
      console.warn('[Claude] WARNING: No cookies in headers! Cloudflare will block.')
    }

    // Extract organization ID from the captured URL
    const url = parsedFetch.url || parsedFetch?.request?.url || ''
    const orgMatch = url.match(/\/organizations\/([a-f0-9-]+)/i)
    if (orgMatch) {
      this._orgId = orgMatch[1]
      if (this._log) console.debug(`[Claude] Extracted org ID from URL: ${this._orgId}`)
    } else if (this._log) {
      console.warn('[Claude] WARNING: No org ID found in URL. Will need discovery.')
    }

    if (this._log) console.debug('[Claude] Initialized from capture JSON')
  }

  async uploadFile(file) {
    if (!this._orgId) throw new Error('Organization ID not set')

    const { filename, data } = file

    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2)
    const CRLF = '\r\n'
    const header =
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
      `Content-Type: application/octet-stream${CRLF}${CRLF}`
    const footer = `${CRLF}--${boundary}--${CRLF}`

    const bodyBuffer = Buffer.concat([
      Buffer.from(header, 'utf-8'),
      data,
      Buffer.from(footer, 'utf-8'),
    ])

    const res = await this._fetch(
      `${ClaudeAPI.BASE_URL}/${this._orgId}/upload`,
      {
        method: 'POST',
        headers: this._buildHeaders(
          { 'content-type': `multipart/form-data; boundary=${boundary}` },
          `/${this._orgId}/upload`,
        ),
        body: bodyBuffer,
      },
      true,
    )

    const body = res.data
    if (!body.success || !body.file_uuid) {
      throw new Error(`Claude file upload failed: ${JSON.stringify(body)}`)
    }

    if (this._log) {
      console.debug(
        `[Claude] File uploaded: ${filename} (${data.length} bytes) → ${body.file_uuid} (${body.file_kind})`,
      )
    }

    return body.file_uuid
  }

  async chatCompletion(
    prompt,
    chatSessionId = null,
    parentMessageId = null,
    model = 'claude-sonnet-4-6',
    tools = [],
    fileIds = [],
    reasoningEffort = null,
    isEphemeral = false,
  ) {
    await humanDelay(1e3, 3e3)
    if (!this._orgId) throw new Error('Organization ID not set')

    // Generate conversation UUID for new conversations (client-side pregen)
    if (!chatSessionId) {
      chatSessionId = generateUUID()
    }

    const humanMessageUuid = generateUUID()
    const assistantMessageUuid = generateUUID()

    const body = {
      prompt,
      timezone: this._body.timezone,
      locale: this._body.locale,
      model: isEphemeral ? 'claude-haiku-4-5-20251001' : model,
      tools,
      turn_message_uuids: {
        human_message_uuid: humanMessageUuid,
        assistant_message_uuid: assistantMessageUuid,
      },
      attachments: [],
      files: fileIds,
      sync_sources: [],
      completion_request_id: generateUUID(),
      rendering_mode: 'messages',
    }

    // Claude's `thinking_mode` gates extended thinking; `effort` is the
    // reasoning-effort tier. VS Code forwards the label verbatim, so we map it
    // directly: a "<Tier> Think" label enables thinking, a bare tier disables
    // it. O(1) lookup keyed by the exact labels VS Code advertises
    // (utils/sync-ide-config.js); anything not mapped disables thinking.
    const effort = isEphemeral ? REASONING_MAP.Off : REASONING_MAP[reasoningEffort]
    if (effort) {
      if (effort.extended) {
        // Haiku: uses thinking_mode:'extended', no effort tier
        body.thinking_mode = effort.think ? 'extended' : 'off'
      } else {
        body.thinking_mode = effort.think ? 'auto' : 'off'
        if (effort.tier) body.effort = effort.tier
      }
    } else {
      body.thinking_mode = 'off'
    }

    // For new conversations (no parentMessageId), include create_conversation_params
    if (parentMessageId) {
      body.parent_message_uuid = parentMessageId
    } else {
      body.create_conversation_params = {
        name: '',
        model,
        include_conversation_preferences: !isEphemeral,
        paprika_mode: null,
        compass_mode: null,
        tool_search_mode: 'off',
        is_temporary: isEphemeral,
        enabled_imagine: false,
      }
    }

    const path = `/organizations/${this._orgId}/chat_conversations/${chatSessionId}/completion`

    if (this._log)
      console.debug('[PROMPT] REQ', {
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

  /**
   * Delete a single chat conversation server-side.
   * @param {string} chatSessionId - the conversation UUID to delete
   */
  async deleteSession(chatSessionId) {
    if (!this._orgId) throw new Error('Organization ID not set')

    const url = `${ClaudeAPI.BASE_URL}/organizations/${this._orgId}/chat_conversations/${chatSessionId}`
    const res = await this._fetch(url, {
      method: 'DELETE',
      headers: this._buildHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ uuid: chatSessionId }),
    })

    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch((caughtErr) => {
        console.error('res.text() failed:', caughtErr)
        return ''
      })
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
  }

  /**
   * Fetch account profile from /api/account_profile.
   * Used to verify session credentials are valid.
   * Returns account profile data on success, throws on failure.
   */
  async getCurrentUser() {
    const headers = this._buildHeaders()
    delete headers['accept-encoding']

    const res = await this._fetch(
      `${ClaudeAPI.BASE_URL}/account_profile`,
      {
        method: 'GET',
        headers,
      },
      true,
    )

    if (res.status !== 200 || !res.data) {
      throw new Error(`Failed to get account profile: HTTP ${res.status}`)
    }

    return res.data
  }

  _captureResponseHeaders(res) {
    // Capture cookies from response
    this._cookies.captureFromFetchHeaders(res.headers, ' Claude')
    // Update stored cookie header for future requests
    this._headers['cookie'] = this._cookies.toString()
  }

  // ─── Headers builder ───────────────────────────────────────────

  /**
   * Build headers for a request.
   */
  _buildHeaders(overrides = {}, _targetPath = '/') {
    const src = this._headers
    const cookieStr = this._cookies.toString()

    const base = {
      accept: overrides.accept || '*/*',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': src['accept-language'] || 'en-US,en;q=0.9',
      ...(src['anthropic-anonymous-id'] && {
        'anthropic-anonymous-id': src['anthropic-anonymous-id'],
      }),
      'anthropic-client-platform': src['anthropic-client-platform'] || 'web_claude_ai',
      ...(src['anthropic-client-sha'] && { 'anthropic-client-sha': src['anthropic-client-sha'] }),
      ...(src['anthropic-client-version'] && {
        'anthropic-client-version': src['anthropic-client-version'],
      }),
      ...(src['anthropic-device-id'] && { 'anthropic-device-id': src['anthropic-device-id'] }),
      'content-type': overrides['content-type'] || 'application/json',
      ...(cookieStr && { cookie: cookieStr }),
      ...(overrides.accept === 'text/event-stream' && { origin: 'https://claude.ai' }),
      priority: 'u=1, i',
      referer: src['referer'] || 'https://claude.ai/chat',
      'sec-ch-ua': src['sec-ch-ua'] || '"Chromium";v="148", "Brave";v="148", "Not/A)Brand";v="99"',
      'sec-ch-ua-mobile': src['sec-ch-ua-mobile'] || '?0',
      'sec-ch-ua-platform': src['sec-ch-ua-platform'] || '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent':
        src['user-agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      ...(src['x-activity-session-id'] && {
        'x-activity-session-id': src['x-activity-session-id'],
      }),
    }

    const extra = { ...overrides }
    delete extra.accept
    delete extra['content-type']

    return { ...base, ...extra }
  }
}

module.exports = { ClaudeAPI }
