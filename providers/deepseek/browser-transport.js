/* global window, document, localStorage, Response */
/**
 * DeepSeek browser transport — drives chat.deepseek.com through its own web UI.
 *
 * Same public surface as DeepSeekAPI (createChatSession, warmupSession,
 * chatCompletion, getCurrentUser, deleteSession, deleteAllSessions, uploadFile),
 * so providers/deepseek/router.js and stream-handler.js are unchanged.
 *
 * Prompt delivery: CDP Input.insertText — atomic, handles multi-KB prompts
 * without dropping characters (page.keyboard.type() is unusable for large text).
 * No clipboard permissions required: insertText is a synthesized input event.
 *
 * Stream delivery: page-side fetch/XHR tee installed via context.addInitScript
 * BEFORE navigation. The hook clones the ReadableStream, forwards one branch to
 * the app, and pushes chunks back to Node via exposeFunction. Chunks arrive
 * live, so stream-handler.js sees true token-by-token deltas.
 *
 *   - Reason for the hook over CDP Fetch: Fetch at Response stage is unreliable
 *     for text/event-stream in some Chromium builds (no requestPaused until body
 *     begins, IO.read/continueResponse race). The page-side tee has none of
 *     those problems.
 *
 * Navigation: _gotoFast() uses waitUntil:'commit' (not domcontentloaded) so
 * goto resolves the moment the HTTP response arrives — DeepSeek's SPA boot is
 * slow; composer readiness is awaited separately via _waitForComposer().
 *
 * Session model:
 *   - New chat:  createChatSession() clicks "New chat", sends a warmup prompt,
 *                reads UUID from the URL /a/chat/s/<uuid>.
 *   - Existing:  chatCompletion() navigates to the original chat URL if not
 *                already there, so DeepSeek's web UI opens the thread with
 *                full history and the composer reuses it.
 *
 * Limitations (v3):
 *   - uploadFile() throws — DOM file-picker flow not implemented; ref_file_ids [].
 *   - parent_message_id is server-assigned; the value the router passes is ignored.
 *   - profile dir is single-instance — cannot share with Playwright MCP or run
 *     two ZeroKey processes on the same dir.
 *   - DeepThink / Search toggles are best-effort (aria + class heuristics).
 */

const fs = require('fs')
const path = require('path')
const { PassThrough } = require('stream')
const { chromium } = require('playwright')
const { humanDelay } = require('../../utils/human-delay')

const TEMP_DIR = path.join(__dirname, '..', '..', 'temp')
const DEFAULT_PROFILE = path.join(TEMP_DIR, 'deepseek-transport-profile')
const START_URL = 'https://chat.deepseek.com/'
const COMPLETION_PATH = '/api/v0/chat/completion'

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const LOGIN_POLL_MS = 1500
const TAP_TIMEOUT_MS = 90 * 1000
const NEW_CHAT_TIMEOUT_MS = 15 * 1000

class DeepSeekBrowserTransport {
  constructor(options = {}) {
    this._log = options.log !== false
    this._headless = options.headless ?? false
    this._profileDir = options.profileDir || DEFAULT_PROFILE
    this._context = null
    this._page = null
    this._cdp = null
    this._launchPromise = null
    this._streamHookReady = null
    this._pendingTap = null
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initializeFromJSON(_parsedFetch) {
    await this._ensureContext()
  }

  async _ensureContext() {
    if (!this._launchPromise) this._launchPromise = this._launch()
    return this._launchPromise
  }

  async _launch() {
    fs.mkdirSync(this._profileDir, { recursive: true })
    if (this._log) console.debug(`[DeepSeek/browser] launching profile ${this._profileDir}`)

    this._context = await chromium.launchPersistentContext(this._profileDir, {
      headless: this._headless,
      viewport: { width: 1280, height: 800 },
      // NOTE: no permissions array — Input.insertText is a CDP input event,
      // it never touches the clipboard. Requesting clipboard perms made
      // launch negotiate them and stalled navigation by 30s+.
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--hide-crash-restore-bubble',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-features=Translate,MediaRouter,OptimizationHints',
      ],
    })

    // Register the page-side tee BEFORE any navigation — addInitScript only
    // applies to future navigations, so this must run before goto.
    this._streamHookReady = this._installStreamHook()

    this._page = this._context.pages()[0] || (await this._context.newPage())
    await this._streamHookReady

    await this._gotoFast(START_URL)
    const ok = await this._waitForLogin(LOGIN_TIMEOUT_MS)
    if (!ok) {
      throw new Error('[DeepSeek/browser] login timed out — open the profile window and sign in')
    }

    this._cdp = await this._context.newCDPSession(this._page)
    if (this._log) console.debug('[DeepSeek/browser] stream tee installed')
  }

  // Navigation that resolves the moment the server responds (commit), not
  // when the DOM is parsed — DeepSeek's SPA boot is slow and blocking on
  // domcontentloaded costs 20-30s. Composer readiness is checked separately.
  async _gotoFast(url) {
    try {
      await this._page.goto(url, { waitUntil: 'commit', timeout: 30_000 })
    } catch (err) {
      if (this._log) console.debug(`[DeepSeek/browser] goto ${url} → ${err.message}`)
    }
  }

  // Page-side hook: tees any /chat/completion response body and forwards the
  // second branch to Node via __dsChunk / __dsDone / __dsError exposeFunctions.
  async _installStreamHook() {
    await this._context.exposeFunction('__dsChunk', (arr) => {
      const p = this._pendingTap
      if (!p) return
      p.stream.push(Buffer.from(arr))
    })
    await this._context.exposeFunction('__dsDone', () => {
      const p = this._pendingTap
      if (!p) return
      p.stream.end()
    })
    await this._context.exposeFunction('__dsError', (msg) => {
      const p = this._pendingTap
      if (!p) return
      p.stream.destroy(new Error(msg))
    })

    await this._context.addInitScript((completionPath) => {
      if (window.__dsTeeInstalled) return
      window.__dsTeeInstalled = true

      const handle = (url, response) => {
        if (!url || !url.includes(completionPath)) return response
        if (!response || !response.body) return response
        try {
          const [a, b] = response.body.tee()
          const reader = b.getReader()
          ;(async () => {
            try {
              while (true) {
                const { value, done } = await reader.read()
                if (done) break
                if (value && value.length) window.__dsChunk(Array.from(value))
              }
              window.__dsDone()
            } catch (e) {
              window.__dsError(String(e && e.message ? e.message : e))
            }
          })()
          return new Response(a, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        } catch (e) {
          window.__dsError('tee failed: ' + (e && e.message ? e.message : e))
          return response
        }
      }

      const origFetch = window.fetch
      window.fetch = async function (...args) {
        const res = await origFetch.apply(this, args)
        const url =
          typeof args[0] === 'string' ? args[0] : args[0] && args[0].url ? args[0].url : ''
        return handle(url, res)
      }

      const OrigXHR = window.XMLHttpRequest
      function PatchedXHR() {
        const xhr = new OrigXHR()
        const origOpen = xhr.open
        xhr.open = function (method, url, ...rest) {
          this.__dsUrl = url
          return origOpen.call(this, method, url, ...rest)
        }
        xhr.addEventListener('readystatechange', () => {
          if (xhr.readyState === 4 && xhr.__dsUrl && xhr.__dsUrl.includes(completionPath)) {
            try {
              const text = xhr.responseText || ''
              if (text) window.__dsChunk(Array.from(new TextEncoder().encode(text)))
              window.__dsDone()
            } catch (e) {
              window.__dsError(String(e && e.message ? e.message : e))
            }
          }
        })
        return xhr
      }
      window.XMLHttpRequest = PatchedXHR
    }, COMPLETION_PATH)
  }

  async _waitForLogin(timeoutMs) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const has = await this._page
        .evaluate(() => {
          try {
            const raw = localStorage.getItem('userToken')
            return raw ? Boolean(JSON.parse(raw).value) : false
          } catch {
            return false
          }
        })
        .catch(() => false)
      if (has) return true
      await this._page.waitForTimeout(LOGIN_POLL_MS)
    }
    return false
  }

  async close() {
    if (this._context) {
      await this._context.close().catch(() => {})
      this._context = null
      this._page = null
      this._cdp = null
      this._launchPromise = null
      this._streamHookReady = null
    }
  }

  // ── Tap plumbing ─────────────────────────────────────────────────────────

  _tapCompletion() {
    return new Promise((resolve, reject) => {
      const stream = new PassThrough()
      this._pendingTap = { stream, resolve, reject }
      setTimeout(() => {
        if (this._pendingTap && this._pendingTap.resolve === resolve) {
          this._pendingTap = null
          reject(new Error('[DeepSeek/browser] stream tap timed out'))
        }
      }, TAP_TIMEOUT_MS)
      resolve(stream)
    })
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  async createChatSession() {
    await this._ensureContext()
    await humanDelay()

    try {
      const btn = this._page
        .locator('div')
        .filter({ hasText: /^New chat$/ })
        .first()
      await btn.click({ timeout: 5000 })
    } catch {
      await this._gotoFast(`${START_URL}a/chat`)
    }
    await this._waitForComposer(15_000)

    const tap = this._tapCompletion()
    await this._sendPrompt(this._warmupPrompt())

    await this._page.waitForURL(/\/a\/chat\/s\//, { timeout: NEW_CHAT_TIMEOUT_MS })
    const m = /\/a\/chat\/s\/([a-f0-9-]{36})/i.exec(this._page.url())
    if (!m) {
      throw new Error(
        `[DeepSeek/browser] could not read chat_session_id from URL: ${this._page.url()}`,
      )
    }

    const warmupStream = await tap
    await drain(warmupStream)
    return m[1]
  }

  async warmupSession(_chatSessionId) {}

  _warmupPrompt() {
    const a = Math.floor(Math.random() * 900) + 100
    const b = Math.floor(Math.random() * 900) + 100
    return `What is ${a} + ${b}?`
  }

  // ── Chat ─────────────────────────────────────────────────────────────────

  async chatCompletion(
    chatSessionId,
    prompt,
    _parentMessageId,
    thinkingEnabled,
    searchEnabled,
    _modelType,
    _refFileIds,
  ) {
    await this._ensureContext()
    await humanDelay()

    const target = `${START_URL}a/chat/s/${chatSessionId}`
    if (!this._page.url().startsWith(target)) {
      await this._gotoFast(target)
      await this._waitForComposer(15_000)
    }

    await this._setToggle('DeepThink', Boolean(thinkingEnabled))
    await this._setToggle('Search', Boolean(searchEnabled))

    const tap = this._tapCompletion()
    await this._sendPrompt(prompt)
    return tap
  }

  // Wait until the composer is interactive. Fast when the SPA is already
  // warm; falls back to 'attached' state which resolves earlier than 'visible'.
  async _waitForComposer(timeoutMs) {
    try {
      await this._page
        .locator('textarea, div[contenteditable="true"]')
        .first()
        .waitFor({ state: 'visible', timeout: timeoutMs })
    } catch {
      /* send will surface the error if composer never appears */
    }
  }

  // Atomic insert via CDP — handles arbitrarily large prompts without the
  // per-char event storm that page.keyboard.type() generates.
  async _sendPrompt(text) {
    const composer = this._page.locator('textarea, div[contenteditable="true"]').first()
    await composer.click()
    await composer.fill('') // clear draft

    await composer.focus()
    if (this._cdp) {
      await this._cdp.send('Input.insertText', { text })
    } else {
      await this._page.evaluate((t) => {
        document.execCommand('insertText', false, t)
      }, text)
    }

    await composer.press('Enter')
  }

  async _setToggle(labelText, desiredOn) {
    try {
      const btn = this._page
        .locator(`div[role="button"]:has-text("${labelText}"), button:has-text("${labelText}")`)
        .first()
      if ((await btn.count()) === 0) return

      const isOn = await btn.evaluate((el) => {
        const aria = el.getAttribute('aria-pressed') || el.getAttribute('aria-checked')
        if (aria === 'true') return true
        if (aria === 'false') return false
        return /(active|selected|checked|enabled)/i.test(el.className || '')
      })

      if (isOn !== desiredOn) await btn.click({ timeout: 3000 })
    } catch {
      /* non-fatal */
    }
  }

  // ── Users / sessions ─────────────────────────────────────────────────────

  async getCurrentUser() {
    await this._ensureContext()
    return this._page.evaluate(async () => {
      const r = await fetch('https://chat.deepseek.com/api/v0/users/current', {
        credentials: 'include',
      })
      return r.json()
    })
  }

  async deleteSession(chatSessionId) {
    await this._ensureContext()
    await this._page.evaluate(async (sid) => {
      await fetch('https://chat.deepseek.com/api/v0/chat_session/delete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_session_id: sid }),
      })
    }, chatSessionId)
  }

  async deleteAllSessions() {
    await this._ensureContext()
    await this._page.evaluate(async () => {
      await fetch('https://chat.deepseek.com/api/v0/chat_session/delete_all', {
        method: 'POST',
        credentials: 'include',
      })
    })
  }

  async uploadFile(_file) {
    throw new Error('[DeepSeek/browser] file upload via browser transport not implemented yet')
  }
}

function drain(readable) {
  return new Promise((resolve, reject) => {
    readable.on('data', () => {})
    readable.on('end', resolve)
    readable.on('error', reject)
  })
}

let _shared = null
function getSharedTransport(options) {
  if (!_shared) _shared = new DeepSeekBrowserTransport(options)
  return _shared
}

module.exports = { DeepSeekBrowserTransport, getSharedTransport }
