'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const diagnostics = require('../utils/diagnostics')

test('sanitize redacts bearer tokens in strings', () => {
  const out = diagnostics.sanitize('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')
  assert.doesNotMatch(out, /abcdefghijkl/)
  assert.match(out, /<redacted>/)
})

test('sanitize walks nested objects', () => {
  const out = diagnostics.sanitize({
    outer: { inner: { access: 'secret-token-value', other: 'visible' } },
  })
  assert.doesNotMatch(JSON.stringify(out), /secret-token-value/)
  assert.match(JSON.stringify(out), /visible/)
})

test('sanitize caps long strings', () => {
  const long = 'x'.repeat(diagnostics.MAX_STRING_CHARS + 500)
  const out = diagnostics.sanitize(long)
  assert.ok(out.length <= diagnostics.MAX_STRING_CHARS + 20)
  assert.match(out, /truncated/)
})

test('sanitize caps array length', () => {
  const arr = Array.from({ length: diagnostics.MAX_ARRAY_ITEMS + 10 }, (_, i) => i)
  const out = diagnostics.sanitize(arr)
  assert.equal(out.length, diagnostics.MAX_ARRAY_ITEMS + 1)
  assert.equal(out[out.length - 1], '<more entries truncated>')
})

test('sanitize caps object keys', () => {
  const obj = {}
  for (let i = 0; i < diagnostics.MAX_OBJECT_KEYS + 10; i += 1) obj['k' + i] = i
  const out = diagnostics.sanitize(obj)
  assert.equal(out._truncated, true)
})

test('sanitize limits nesting depth', () => {
  let deep = { value: 'bottom' }
  for (let i = 0; i < diagnostics.MAX_DEPTH + 5; i += 1) deep = { nested: deep }
  const out = JSON.stringify(diagnostics.sanitize(deep))
  assert.match(out, /<truncated>/)
})

test('versionPayload reports process metadata', () => {
  const payload = diagnostics.versionPayload(Date.now() - 1000)
  assert.equal(payload.node, process.version)
  assert.equal(payload.platform, process.platform)
  assert.equal(payload.pid, process.pid)
})

test('diagnosePayload tolerates a missing db', () => {
  const payload = diagnostics.diagnosePayload({
    host: '127.0.0.1',
    port: 7250,
    startedAt: Date.now(),
    db: null,
  })
  assert.equal(payload.status, 'ok')
  assert.equal(payload.listener, '127.0.0.1:7250')
})
