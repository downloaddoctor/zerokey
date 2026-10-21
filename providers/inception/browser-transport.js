'use strict'
/* global window, Response */
/**
 * Inception browser transport: drives chat.inceptionlabs.ai through its own web
 * UI like a real user (same pattern as providers/deepseek/browser-transport.js).
 * The site is authless, so nothing is captured and nothing is pasted.
 *
 * - Prompt: typed into the composer with CDP Input.insertText, then Enter.
 * - Settings: web search follows opts.webSearch and the thinking mode is picked from the
 *   real listbox before every send (they persist in the page, so unchanged
 *   values cost no clicks).
 * - Stream: an init-script fetch tee copies the app's own POST /api/chat
 *   response to Node, so the stream-handler still sees live deltas.
 * - Threads: the site keeps chats only in the browser. The UI thread is reused
 *   and resends its own history, so only the new prompt is typed. "New Chat"
 *   is clicked on the first turn, after any failure, for ephemeral requests
 *   and when the router asks for a rotation (opts.newThread).
 * - One composer means one request at a time (a queue holds the next call until
 *   the current stream closes). Closing the stream early clicks "Stop generating".
 */

const fs = require('fs')
const path = require('path')
const { PassThrough } = require('stream')
const { chromium } = require('playwright')

const { CONFIG } = require('../../config/constants')
const { humanDelay } = require('../../utils/human-delay')

const ORIGIN = 'https://chat.inceptionlabs.ai'
const CHAT_PATH = '/api/chat'
const PROFILES_ROOT = path.join(CONFIG.DATA_DIR, 'profiles', 'inception')
const CHECKPOINT_TIMEOUT_MS = 45_000
const HEAD_TIMEOUT_MS = 90_000
const HEADLESS = /^(1|true|yes)$/i.test(process.env.INCEPTION_HEADLESS || '')
const COMPOSER_NAME = 'How can I help you?'

// The site refuses to continue a thread that grew too large. Recover by
// opening a new chat and resending once.
const CONVERSATION_TOO_LONG_RE = /conversation is too long|start a new chat/i

function isConversationTooLong(err) {
  return CONVERSATION_TOO_LONG_RE.test(String((err && err.message) || err || ''))
}

function statusError(status, type, text) {
  const err = new Error(`[Inception] chat: HTTP ${status} (${type || 'no content-type'}): ${text}`)
  err.status = status
  err.statusCode = status
  return err
}

function capitalize(s) {
  const v = String(s || 'medium')
  return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase()
}

class InceptionBrowserTransport {
  constructor(options = {}) {
    this._log = options.log !== false
    this._headless = options.headless ?? HEADLESS
    const key = String(options.username || 'default')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 32)
    this._profileDir = options.profileDir || path.join(PROFILES_ROOT, key || 'default')
    this._context = null
    this._page = null
    this._cdp = null
    this._launchPromise = null
    this._pending = null
    this._gate = Promise.resolve()
    this._threadLen = -1
  }

  /** Authless: nothing to read from a capture. Kept for the provider contract. */
  async initializeFromJSON() {}

  _reset() {
    this._context = null
    this._page = null
    this._cdp = null
    this._launchPromise = null
    this._threadLen = -1
    const p = this._pending
    this._pending = null
    if (p) {
      p.reject(new Error('[Inception/browser] browser closed'))
      p.stream.destroy(new Error('[Inception/browser] browser closed'))
    }
  }

  _ensureContext() {
    if (this._page && this._page.isClosed()) this._reset()
    if (!this._launchPromise) {
      this._launchPromise = this._launch().catch((err) => {
        this._launchPromise = null
        throw err
      })
    }
    return this._launchPromise
  }

  async _launch() {
    fs.mkdirSync(this._profileDir, { recursive: true })
    if (this._log) console.debug(`[Inception/browser] launching profile ${this._profileDir}`)

    const context = await chromium.launchPersistentContext(this._profileDir, {
      headless: this._headless,
      viewport: null,
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    })
    this._context = context
    context.on('close', () => {
      if (this._context === context) this._reset()
    })

    await this._installStreamHook(context)

    this._page = context.pages()[0] || (await context.newPage())
    try {
      await this._page.goto(ORIGIN + '/', { waitUntil: 'commit', timeout: 30_000 })
    } catch (err) {
      console.error('inception: goto failed:', err)
    }
    await this._waitForCheckpoint()
    await this._waitForComposer()
    this._cdp = await context.newCDPSession(this._page)
  }

  async _installStreamHook(context) {
    await context.exposeFunction('__incHead', (status, type, mitigated, text) => {
      const p = this._pending
      if (!p) return
      if (status >= 400 || !String(type).includes('text/event-stream')) {
        const err = statusError(status, type, String(text || '').replace(/\s+/g, ' '))
        err.challenge = mitigated === 'challenge'
        p.reject(err)
      } else {
        p.resolve()
      }
    })
    await context.exposeFunction('__incChunk', (arr) => {
      const p = this._pending
      if (p && !p.stream.destroyed) p.stream.write(Buffer.from(arr))
    })
    await context.exposeFunction('__incDone', () => {
      const p = this._pending
      if (p && !p.stream.destroyed) p.stream.end()
    })
    await context.exposeFunction('__incError', (msg) => {
      const p = this._pending
      if (p && !p.stream.destroyed) p.stream.destroy(new Error(msg))
    })

    await context.addInitScript((chatPath) => {
      if (window.__incTee) return
      window.__incTee = true
      const orig = window.fetch
      window.fetch = async function (...args) {
        const res = await orig.apply(this, args)
        try {
          const first = args[0]
          const url = typeof first === 'string' ? first : (first && first.url) || ''
          const method = String((args[1] && args[1].method) || (first && first.method) || 'GET')
          if (method.toUpperCase() !== 'POST' || !url.includes(chatPath)) return res
          const type = res.headers.get('content-type') || ''
          const mitigated = res.headers.get('x-vercel-mitigated') || ''
          if (!res.ok || !type.includes('text/event-stream') || !res.body) {
            const text = await res
              .clone()
              .text()
              .catch(() => '')
            window.__incHead(res.status, type, mitigated, text.slice(0, 300))
            return res
          }
          window.__incHead(res.status, type, mitigated, '')
          const [a, b] = res.body.tee()
          const reader = b.getReader()
          ;(async () => {
            try {
              for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                if (value && value.length) window.__incChunk(Array.from(value))
              }
              window.__incDone()
            } catch (e) {
              console.error('inception: stream read failed:', e)
              window.__incError(String(e && e.message ? e.message : e))
            }
          })()
          return new Response(a, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          })
        } catch (e) {
          console.error('inception: stream tee failed:', e)
          return res
        }
      }
    }, CHAT_PATH)
  }

  async _waitForCheckpoint() {
    const start = Date.now()
    while (Date.now() - start < CHECKPOINT_TIMEOUT_MS) {
      const title = await this._page.title().catch(() => '')
      if (title && !/security checkpoint/i.test(title)) return
      await this._page.waitForTimeout(500)
    }
    throw new Error('[Inception/browser] Vercel Security Checkpoint did not clear in time')
  }

  _composer() {
    return this._page.getByRole('textbox', { name: COMPOSER_NAME })
  }

  async _waitForComposer() {
    await this._composer().waitFor({ state: 'visible', timeout: 30_000 })
  }

  async _newChat() {
    await this._dismissOverlays()
    const btn = this._page.getByRole('button', { name: 'New Chat', exact: true }).first()
    if ((await btn.count()) > 0) {
      await btn.click({ timeout: 5000 })
    } else {
      await this._page.goto(ORIGIN + '/', { waitUntil: 'commit', timeout: 30_000 })
      await this._waitForCheckpoint()
    }
    await this._waitForComposer()
    this._threadLen = 0
  }

  /** The cookie banner is fixed over the composer toolbar and swallows clicks; close it like a user. */
  async _dismissBanner() {
    try {
      const close = this._page.getByRole('button', { name: 'Close', exact: true }).first()
      if ((await close.count()) > 0 && (await close.isVisible())) {
        await close.click({ timeout: 2000 })
        await this._page.waitForTimeout(200)
      }
    } catch (err) {
      console.error('inception: banner dismiss failed:', err)
    }
  }

  /** Close whatever the site puts over the page: the signup nudge modal, then the cookie banner. */
  async _dismissOverlays() {
    try {
      const nudge = this._page.getByRole('dialog').filter({ hasText: 'Continue Chatting' })
      if ((await nudge.count()) > 0) {
        await nudge.getByRole('button', { name: 'Continue Chatting' }).click({ timeout: 3000 })
        await nudge
          .first()
          .waitFor({ state: 'detached', timeout: 3000 })
          .catch(() => {})
      }
    } catch (err) {
      console.error('inception: signup nudge dismiss failed:', err)
    }
    await this._dismissBanner()
  }

  async _setWebSearch(on) {
    const btn = this._page.getByRole('button', { name: /^Web search/ }).first()
    if ((await btn.count()) === 0) return
    const pressed = async () => (await btn.getAttribute('aria-pressed')) === 'true'
    if ((await pressed()) === on) return
    await btn.click({ timeout: 3000 })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && (await pressed()) !== on) {
      await this._page.waitForTimeout(100)
    }
  }

  async _setEffort(label) {
    const btn = this._page.getByRole('button', { name: /^Thinking mode:/ }).first()
    if ((await btn.count()) === 0) return
    const current = ((await btn.getAttribute('aria-label')) || '').replace(/^Thinking mode:\s*/, '')
    if (current.toLowerCase() === label.toLowerCase()) return
    await btn.click({ timeout: 3000 })
    await this._page.getByRole('option', { name: label, exact: true }).click({ timeout: 3000 })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const now = ((await btn.getAttribute('aria-label')) || '').replace(/^Thinking mode:\s*/, '')
      if (now.toLowerCase() === label.toLowerCase()) return
      await this._page.waitForTimeout(100)
    }
  }

  async _send(text) {
    const composer = this._composer()
    await this._dismissOverlays()
    await composer.click()
    await composer.fill('')
    if (this._cdp) await this._cdp.send('Input.insertText', { text })
    else await composer.fill(text)
    await composer.press('Enter')
  }

  async _stop() {
    if (!this._page || this._page.isClosed()) return
    const stop = this._page.getByRole('button', { name: 'Stop generating' }).first()
    if ((await stop.count().catch(() => 0)) > 0) await stop.click({ timeout: 2000 }).catch(() => {})
  }

  /**
   * One chat turn through the UI. opts: { prompt, fresh, newThread, reasoningEffort, webSearch, signal }.
   * `history` is the router's message list BEFORE this turn. Resolves to a Readable of the
   * raw SSE bytes once the response headers arrive; the next call waits until it closes.
   */
  async chatCompletion(opts) {
    const previous = this._gate
    let release
    this._gate = new Promise((resolve) => {
      release = resolve
    })
    await previous

    try {
      return await this._run(opts, release)
    } catch (err) {
      this._pending = null
      if (isConversationTooLong(err)) {
        // The upstream thread is too long to continue: open a fresh chat and
        // resend exactly once with the current prompt.
        console.warn('[Inception/browser] conversation too long — rotating to a new chat')
        this._threadLen = -1
        await this._newChat().catch((newChatErr) => {
          console.error('inception: new chat after too-long failed:', newChatErr)
        })
        try {
          const recovered = await this._run(opts, release)
          release()
          return recovered
        } catch (recoveredErr) {
          this._threadLen = -1
          release()
          throw recoveredErr
        }
      }
      this._threadLen = -1
      release()
      throw err
    }
  }

  async _run(opts, release) {
    await this._ensureContext()
    await humanDelay(3000, 5000)

    // The UI keeps the thread and resends its own history, so only the new prompt is typed.
    // A new chat is opened for the first turn, after any failure, and for ephemeral requests.
    if (opts.fresh || opts.newThread || this._threadLen < 0) await this._newChat()
    const prompt = opts.prompt

    await this._dismissOverlays()
    await this._setWebSearch(Boolean(opts.webSearch))
    await this._setEffort(capitalize(opts.reasoningEffort))

    const stream = new PassThrough()
    const head = new Promise((resolve, reject) => {
      this._pending = { stream, resolve, reject }
    })
    const timer = setTimeout(() => {
      if (this._pending && this._pending.stream === stream) {
        this._pending.reject(new Error('[Inception/browser] no response from the page in time'))
      }
    }, HEAD_TIMEOUT_MS)

    let finished = false
    stream.once('end', () => {
      finished = true
    })
    stream.once('close', () => {
      if (this._pending && this._pending.stream === stream) this._pending = null
      if (!finished) {
        this._threadLen = -1
        this._stop().catch(() => {})
      }
      release()
    })
    if (opts.signal) {
      if (opts.signal.aborted) stream.destroy()
      else opts.signal.addEventListener('abort', () => stream.destroy(), { once: true })
    }

    try {
      await this._send(prompt)
      await head
    } finally {
      clearTimeout(timer)
    }

    // Real turns accumulate two messages per browser thread; ephemeral (fresh)
    // calls always rotate to a new chat, so they leave no reusable thread.
    if (opts.fresh) this._threadLen = -1
    else this._threadLen += 2
    return stream
  }

  async close() {
    const context = this._context
    if (!context) return
    this._reset()
    await context.close().catch((err) => {
      console.error('inception: context.close() failed:', err)
    })
  }
}

let _shared = null

function getSharedTransport(options = {}) {
  if (!_shared) _shared = new InceptionBrowserTransport(options)
  return _shared
}

module.exports = { InceptionBrowserTransport, getSharedTransport }
