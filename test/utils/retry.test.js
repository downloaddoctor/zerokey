'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const retry = require('../../utils/retry')

test('401 is never retried', () => {
  const result = retry.classify({ status: 401 })
  assert.equal(result.retry, false)
  assert.equal(result.kind, 'unauthorized')
  assert.equal(result.maxAttempts, 1)
})

test('403 is retried exactly twice', () => {
  const result = retry.classify({ status: 403 })
  assert.equal(result.retry, true)
  assert.equal(result.maxAttempts, retry.FORBIDDEN_MAX_ATTEMPTS)
})

test('429 is never retried by this layer', () => {
  const result = retry.classify({ status: 429 })
  assert.equal(result.retry, false)
  assert.equal(result.kind, 'rate_limited')
  assert.equal(result.maxAttempts, 1)
})

test('5xx is retried three times', () => {
  const result = retry.classify({ status: 503 })
  assert.equal(result.retry, true)
  assert.equal(result.maxAttempts, retry.MAX_ATTEMPTS)
})

test('generic 4xx is permanent', () => {
  const result = retry.classify({ status: 404 })
  assert.equal(result.retry, false)
  assert.equal(result.kind, 'client_error')
})

test('network error codes are retried', () => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET']) {
    const result = retry.classify({ code })
    assert.equal(result.retry, true, code + ' should retry')
    assert.equal(result.kind, 'network', code + ' should be network class')
  }
})

test('upstream_timeout is retried', () => {
  const result = retry.classify({ code: 'upstream_timeout' })
  assert.equal(result.retry, true)
  assert.equal(result.kind, 'timeout')
})

test('aborted signal is terminal', () => {
  const controller = new AbortController()
  controller.abort()
  const result = retry.classify({ status: 503 }, controller.signal)
  assert.equal(result.retry, false)
  assert.equal(result.kind, 'aborted')
})

test('statusOf reads .status, .statusCode, .httpStatus in order', () => {
  assert.equal(retry.statusOf({ status: 500 }), 500)
  assert.equal(retry.statusOf({ statusCode: 502 }), 502)
  assert.equal(retry.statusOf({ httpStatus: 503 }), 503)
  assert.equal(retry.statusOf({}), null)
  assert.equal(retry.statusOf(null), null)
})

test('delayMs honours Retry-After seconds', () => {
  const response = { headers: { get: (name) => (name === 'retry-after' ? '30' : null) } }
  assert.equal(retry.delayMs(1, response), 30000)
})

test('delayMs honours Retry-After date', () => {
  const now = Date.now()
  const when = new Date(now + 5000).toUTCString()
  const response = { headers: { get: (name) => (name === 'retry-after' ? when : null) } }
  const delay = retry.delayMs(1, response, now)
  assert.ok(delay >= 4000 && delay <= 6000, 'date-based delay should be ~5000ms, got ' + delay)
})

test('delayMs caps Retry-After at 24h', () => {
  const response = { headers: { get: (name) => (name === 'retry-after' ? '86400' : null) } }
  assert.equal(retry.delayMs(1, response), retry.MAX_RETRY_AFTER_MS)
})

test('delayMs grows exponentially within the cap', () => {
  assert.equal(retry.delayMs(1), 250)
  assert.equal(retry.delayMs(2), 500)
  assert.equal(retry.delayMs(3), 1000)
  assert.equal(retry.delayMs(10), retry.MAX_DELAY_MS)
})

test('sleep resolves after the delay', async () => {
  const started = Date.now()
  await retry.sleep(20)
  assert.ok(Date.now() - started >= 15)
})

test('sleep rejects on an already-aborted signal', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(retry.sleep(1000, controller.signal), { name: 'AbortError' })
})

test('discardResponse is a no-op on missing body', () => {
  assert.doesNotThrow(() => retry.discardResponse(null))
  assert.doesNotThrow(() => retry.discardResponse({}))
})
