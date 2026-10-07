'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const mhi = require('../../../core/mhi')
const SYNTAX = require('../../../engine/syntax')

const ROOT = path.resolve(__dirname, '..')
const SCRATCH = path.join(ROOT, 'temp', 'test', 'mhi-index-scratch')

const S = SYNTAX.SEP

function wrap(name, params = {}) {
  let out = SYNTAX.OPEN + name
  for (const [k, v] of Object.entries(params)) out += S + k + '=' + v
  return out + SYNTAX.CLOSE
}

function reset() {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  fs.mkdirSync(SCRATCH, { recursive: true })
  fs.writeFileSync(path.join(SCRATCH, 'a.txt'), 'hello\n', 'utf8')
}

test('evaluateAssistant returns final for plain text', () => {
  assert.equal(mhi.evaluateAssistant('no tools needed').kind, 'final')
})

test('evaluateAssistant returns calls for a single block', () => {
  const result = mhi.evaluateAssistant(wrap('read', { path: 'C:' }))
  assert.equal(result.kind, 'calls')
  assert.equal(result.calls.length, 1)
})

test('evaluateAssistant returns continue for mixed output', () => {
  const result = mhi.evaluateAssistant('here you go ' + wrap('read', { path: 'x' }))
  assert.equal(result.kind, 'continue')
  assert.equal(result.reason, 'mhi_mixed_output')
})

test('executeCalls dispatches a read', async () => {
  reset()
  const results = await mhi.executeCalls(
    [{ tool: 'read', params: { path: path.join(SCRATCH, 'a.txt') } }],
    { context: { rootPath: SCRATCH }, fileTools: true, cmdTools: false, viewImage: true },
  )
  assert.equal(results[0].ok, true)
  assert.match(results[0].output, /hello/)
})

test('executeCalls refuses cmd when disabled', async () => {
  reset()
  const results = await mhi.executeCalls(
    [{ tool: 'cmd', params: { program: 'node', args: '[]' } }],
    { context: { rootPath: SCRATCH }, fileTools: true, cmdTools: false, viewImage: true },
  )
  assert.equal(results[0].ok, false)
  assert.equal(results[0].code, 'mhi_cmd_disabled')
})

test('appendResult adds an image_url user message for view_image attachments', () => {
  const data = Buffer.from('89504e470d0a1a0a', 'hex')
  const out = mhi.appendResult({ messages: [] }, 'MHI(view_image): IMAGE', [
    { filename: 'x.png', mimeType: 'image/png', data },
  ])
  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[0].role, 'mhi')
  assert.equal(out.messages[1].role, 'user')
  assert.equal(out.messages[1].content[0].type, 'image_url')
  assert.ok(out.messages[1].content[0].image_url.url.startsWith('data:image/png;base64,'))
})

test('executeCalls refuses view_image when disabled', async () => {
  reset()
  const results = await mhi.executeCalls(
    [{ tool: 'view_image', params: { path: path.join(SCRATCH, 'x.png') } }],
    { context: { rootPath: SCRATCH }, fileTools: true, cmdTools: false, viewImage: false },
  )
  assert.equal(results[0].ok, false)
  assert.equal(results[0].code, 'mhi_view_image_disabled')
})

test('formatResults joins text and collects attachments', () => {
  const { text, attachments } = mhi.formatResults([
    { tool: 'read', ok: true, output: 'OK' },
    { tool: 'view_image', ok: true, output: 'IMAGE', attachment: { filename: 'x.png' } },
  ])
  assert.match(text, /MHI\(read\): OK/)
  assert.match(text, /MHI\(view_image\): IMAGE/)
  assert.equal(attachments.length, 1)
})

test('appendResult adds an mhi turn', () => {
  const payload = { messages: [{ role: 'user', content: 'hi' }] }
  const next = mhi.appendResult(payload, 'MHI(read): ok')
  assert.equal(next.messages.length, 2)
  assert.equal(next.messages[1].role, 'mhi')
  assert.equal(next.messages[1].content, 'MHI(read): ok')
})

test('normalizeEnablement defaults are sane', () => {
  assert.deepEqual(mhi.normalizeEnablement(true), {
    fileTools: true,
    cmdTools: false,
    viewImage: false,
  })
  assert.deepEqual(mhi.normalizeEnablement({ fileTools: true, cmdTools: true, viewImage: true }), {
    fileTools: true,
    cmdTools: true,
    viewImage: true,
  })
})
