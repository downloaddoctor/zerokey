'use strict'

/**
 * Bounded retry classification.
 *
 * Providers (and their stream handlers) ask this module what to do with a
 * failed request. The answers are per-class, not per-status-code-guess:
 * a 401 is never retried, a 429 is never retried (the caller already learned
 * the reset time from the provider body or `Retry-After`), and a 5xx is
 * retried a small fixed number of times with exponential backoff.
 *
 * No circuit breaker, no cooldown memory, no cross-request state. Those live
 * in the rate limiter, which is a separate concern.
 */

const MAX_ATTEMPTS = 3
const FORBIDDEN_MAX_ATTEMPTS = 2
const BASE_DELAY_MS = 250
const MAX_DELAY_MS = 2000
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

function statusOf(value) {
  if (!value) return null
  if (Number.isInteger(value.status)) return value.status
  if (Number.isInteger(value.statusCode)) return value.statusCode
  if (Number.isInteger(value.httpStatus)) return value.httpStatus
  return null
}

function headerValue(response, name) {
  if (!response || !response.headers || typeof response.headers.get !== 'function') return null
  return response.headers.get(name)
}

function retryAfterMs(response, now = Date.now()) {
  const value = headerValue(response, 'retry-after')
  if (typeof value !== 'string' || value.trim() === '') return null

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000))
  }

  const when = Date.parse(value)
  if (!Number.isFinite(when)) return null
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, when - now))
}

/**
 * @param {object|Error} value  response-like { status } or Error with .code/.status
 * @param {AbortSignal} [externalSignal]
 * @returns {{ retry: boolean, kind: string, maxAttempts: number }}
 */
function classify(value, externalSignal) {
  if (externalSignal && externalSignal.aborted) {
    return { retry: false, kind: 'aborted', maxAttempts: 1 }
  }

  const status = statusOf(value)

  if (status === 401) return { retry: false, kind: 'unauthorized', maxAttempts: 1 }
  if (status === 403) return { retry: true, kind: 'forbidden', maxAttempts: FORBIDDEN_MAX_ATTEMPTS }
  if (status === 429) return { retry: false, kind: 'rate_limited', maxAttempts: 1 }
  if (status !== null && status >= 500 && status <= 599) {
    return { retry: true, kind: 'server_error', maxAttempts: MAX_ATTEMPTS }
  }
  if (status !== null && status >= 400 && status <= 499) {
    return { retry: false, kind: 'client_error', maxAttempts: 1 }
  }

  if (value && value.code === 'upstream_timeout') {
    return { retry: true, kind: 'timeout', maxAttempts: MAX_ATTEMPTS }
  }
  if (value && typeof value.code === 'string' && NETWORK_CODES.has(value.code)) {
    return { retry: true, kind: 'network', maxAttempts: MAX_ATTEMPTS }
  }
  if (value && (value.name === 'FetchError' || value.name === 'TimeoutError')) {
    return { retry: true, kind: 'network', maxAttempts: MAX_ATTEMPTS }
  }

  return { retry: false, kind: 'permanent', maxAttempts: 1 }
}

/**
 * Exponential backoff with jitter cap. Honours `Retry-After` when the failed
 * value carries a response object.
 *
 * @param {number} attempt   1-based; attempt === 1 is the first failure
 * @param {Response} [response]
 * @param {number} [now]
 */
function delayMs(attempt, response, now = Date.now()) {
  const fromHeader = retryAfterMs(response, now)
  if (fromHeader !== null) return fromHeader

  const exponent = Math.max(0, Number(attempt) - 1)
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent)
}

/**
 * Drain a response body that is about to be retried. Idempotent.
 */
function discardResponse(response) {
  if (!response || !response.body) return
  if (typeof response.body.destroy === 'function') {
    response.body.destroy()
    return
  }
  if (typeof response.body.cancel === 'function') {
    Promise.resolve(response.body.cancel()).catch(() => {
      // Cancelling a discarded body is best-effort.
    })
  }
}

/**
 * Sleep that aborts cleanly when the caller's signal fires.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      const error = new Error('The request was aborted.')
      error.name = 'AbortError'
      reject(error)
      return
    }
    const timer = setTimeout(done, Math.max(0, ms))
    function done() {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort() {
      clearTimeout(timer)
      const error = new Error('The request was aborted.')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

module.exports = {
  BASE_DELAY_MS,
  FORBIDDEN_MAX_ATTEMPTS,
  MAX_ATTEMPTS,
  MAX_DELAY_MS,
  MAX_RETRY_AFTER_MS,
  NETWORK_CODES,
  classify,
  delayMs,
  discardResponse,
  retryAfterMs,
  sleep,
  statusOf,
}
