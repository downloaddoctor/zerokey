'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const c = require('../../providers/claude/connect-rpc')

const HAR = path.join(__dirname, '..', '..', 'temp', 'claude2.ai.har')
const hasHar = fs.existsSync(HAR)

test('varint round-trips beyond 32 bits', () => {
  for (const n of [0, 1, 127, 128, 300, 2 ** 31, 2 ** 32 + 5, 2 ** 40]) {
    const [v, off] = c.readVarint(c.writeVarint(n), 0)
    assert.strictEqual(v, n)
    assert.strictEqual(off, c.writeVarint(n).length)
  }
})

test('frame/unframe round-trips', () => {
  const payload = Buffer.from('hello')
  const frames = c.unframe(Buffer.concat([c.frame(payload), c.frame(payload, 2)]))
  assert.strictEqual(frames.length, 2)
  assert.strictEqual(frames[1].flags, 2)
  assert.ok(frames[0].data.equals(payload))
})

test('makeFrameReader handles split chunks', () => {
  const reader = c.makeFrameReader()
  const buf = c.frame(Buffer.from('abcdef'))
  assert.strictEqual(reader.push(buf.subarray(0, 4)).length, 0)
  assert.strictEqual(reader.push(buf.subarray(4)).length, 1)
})

test('walkProto stops on an overrunning length', () => {
  const bad = Buffer.from([0x0a, 0x7f, 0x41])
  assert.deepStrictEqual(c.walkProto(bad), [])
})

test('buildStreamTimeline reopen with cursor matches the browser body', () => {
  const want = Buffer.from(
    '\n$aec5579e-c55b-4e05-b6ba-f03e48c4ed99\x12\x11\n\x0f1791969316350-0\x18\x01"\x020\x01*\x05en-US0\x01B\x0fAmerica/Chicago',
    'latin1',
  )
  const got = c.buildStreamTimeline({
    conversationId: 'aec5579e-c55b-4e05-b6ba-f03e48c4ed99',
    cursor: '1791969316350-0',
    locale: 'en-US',
    timezone: 'America/Chicago',
  })
  assert.strictEqual(want.length, 89)
  assert.ok(want.equals(got))
})

test('endStreamError surfaces the real Connect error', () => {
  const body = Buffer.from('{"error":{"code":"unauthenticated","message":"bad session"}}')
  const err = c.endStreamError(c.unframe(c.frame(body, 2))[0])
  assert.match(err.message, /unauthenticated: bad session/)
  assert.strictEqual(err.code, 'unauthenticated')
  assert.strictEqual(c.endStreamError({ flags: 2, data: Buffer.from('{}') }), null)
})

test('_assertRpcOk reports status, body and headers for a non-OK response', async () => {
  const api = new c.ClaudeConnectRpc()
  const res = {
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    url: 'https://claude.ai/claudeai-rpc/x',
    headers: { get: (n) => (n === 'content-type' ? 'application/json' : null) },
    text: async () => '{"code":"invalid_argument","message":"bad field"}',
  }
  await assert.rejects(
    () => api._assertRpcOk(res),
    (e) => e.status === 400 && /invalid_argument bad field/.test(e.message),
  )
})

test('_assertRpcOk flags a Cloudflare challenge', async () => {
  const api = new c.ClaudeConnectRpc()
  const res = {
    ok: false,
    status: 403,
    url: 'u',
    headers: { get: () => null },
    text: async () => '<title>Just a moment...</title>',
  }
  await assert.rejects(
    () => api._assertRpcOk(res),
    (e) => e.status === 403 && /Cloudflare challenge/.test(e.message),
  )
})

test('buildStreamTimeline initial open omits f6', () => {
  const base = { conversationId: 'c', locale: 'en-US', timezone: 'UTC' }
  const initial = c.walkProto(c.buildStreamTimeline({ ...base, initial: true }))
  const reopen = c.walkProto(c.buildStreamTimeline(base))
  assert.ok(!initial.some((n) => n.field === 6))
  assert.ok(reopen.some((n) => n.field === 6))
})

test('buildPromptlessAction with a model carries f7 model and f8 tool config', () => {
  const buf = c.buildPromptlessAction({ conversationId: 'c', model: 'claude-sonnet-5-5' })
  const inner = c.walkProto(buf).find((n) => n.field === 15).value[0].value
  const f7 = inner.find((n) => n.field === 7)
  assert.ok(f7)
  assert.ok(inner.some((n) => n.field === 8))
  assert.ok(buf.includes(Buffer.from('local:visualize:show_widget')))
})

test('extractCaptured reads signature, model, tools, locale and tz from the stored body', () => {
  const sig = Buffer.alloc(32, 7)
  const body = c.buildPromptAction({
    conversationId: 'c',
    sessionId: 's',
    seq: 1,
    messageId: 'a',
    replyId: 'b',
    prompt: 'hi',
    model: 'claude-sonnet-5-5',
    signature: sig,
    locale: 'en-US',
    timezone: 'America/Chicago',
  })
  const got = c.extractCaptured({ bodyBase64: body.toString('base64') })
  assert.ok(got.signature.equals(sig))
  assert.strictEqual(got.model, 'claude-sonnet-5-5')
  assert.strictEqual(got.timezone, 'America/Chicago')
  assert.strictEqual(got.locale, 'en-US')
  assert.ok(Buffer.isBuffer(got.toolConfig))
  assert.deepStrictEqual(c.extractCaptured({}), {})
})

test('buildPromptAction throws until the f15 signature is solved', () => {
  assert.throws(
    () =>
      c.buildPromptAction({
        conversationId: 'x',
        sessionId: 's',
        seq: 1,
        messageId: 'a',
        replyId: 'b',
        prompt: 'hi',
      }),
    /f15 signature/,
  )
})

test('buildPromptlessAction matches the HAR', { skip: !hasHar }, () => {
  const har = JSON.parse(fs.readFileSync(HAR, 'utf8'))
  const want = Buffer.from(har.log.entries[5].request.postData.text, 'latin1')
  const got = c.buildPromptlessAction({
    conversationId: 'aec5579e-c55b-4e05-b6ba-f03e48c4ed99',
    locale: 'en-US',
    timezone: 'America/Chicago',
  })
  assert.ok(want.equals(got))
})

test(
  'collector yields assistant deltas, session id and done from the HAR',
  { skip: !hasHar },
  () => {
    const har = JSON.parse(fs.readFileSync(HAR, 'utf8'))
    const entry = har.log.entries.find(
      (e) => /StreamTimeline/.test(e.request.url) && e.response.content.text,
    )
    const frames = c.unframe(Buffer.from(entry.response.content.text, 'base64'))
    const col = c.makeReplyCollector()
    let text = ''
    let done = false
    for (const f of frames) {
      if (f.flags & 0x02) continue
      const r = col.feed(c.walkProto(c.decompressFrame(f)))
      text += r.text.join('')
      done = done || r.done
    }
    assert.ok(text.length > 0)
    assert.ok(done)
    assert.match(col.state.sessionId, /^sess_/)
  },
)
