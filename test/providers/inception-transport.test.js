'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { PassThrough } = require('node:stream')

const { InceptionBrowserTransport } = require('../../providers/inception/browser-transport')

test('browser transport: profile dir is derived from a sanitized username', () => {
  const t = new InceptionBrowserTransport({ log: false, username: 'Some User!' })
  assert.match(t._profileDir, /someuser$/)
})

test('browser transport: _reset rejects and destroys the pending stream', async () => {
  const t = new InceptionBrowserTransport({ log: false })
  const stream = new PassThrough()
  stream.on('error', () => {})
  const head = new Promise((resolve, reject) => {
    t._pending = { stream, resolve, reject }
  })
  t._threadLen = 1
  t._reset()
  await assert.rejects(head, /browser closed/)
  assert.equal(stream.destroyed, true)
  assert.equal(t._pending, null)
  assert.equal(t._threadLen, -1)
  assert.equal(t._page, null)
})
