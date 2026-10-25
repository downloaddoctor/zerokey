'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { limitPrompt } = require('../../utils/overflow')

function fakeCompiler(limit) {
  return { _promptLimit: limit, lastPrompt: null }
}

test('limitPrompt returns a prompt under the limit unchanged', () => {
  const c = fakeCompiler(100)
  assert.equal(limitPrompt(c, 'short'), 'short')
  assert.equal(c.lastPrompt.truncated, false)
  assert.equal(c.lastPrompt.headroom, 95)
  assert.equal(c.lastPrompt.dropped, 0)
})

test('limitPrompt writes the whole prompt to one file and sends a short note', () => {
  const c = fakeCompiler(1000)
  const prompt = 'x'.repeat(5000)
  const out = limitPrompt(c, prompt)
  assert.ok(out.length <= 1000)
  const m = out.match(/^\[TRUNCATED: (\d+) chars left, read them from (.+prompt\.txt)\]\n\n/)
  assert.ok(m)
  const rest = fs.readFileSync(m[2], 'utf8')
  assert.equal(out.slice(m[0].length) + rest, prompt)
  assert.equal(rest.length, Number(m[1]))
  assert.equal(c.lastPrompt.spilled, rest.length)
  assert.equal(c.lastPrompt.dropped, 0)
  fs.rmSync(path.dirname(m[2]), { recursive: true, force: true })
})

test('limitPrompt cuts the inline head on a line break', () => {
  const c = fakeCompiler(1000)
  const prompt = Array.from({ length: 120 }, (_, i) => 'line ' + i + ' ' + 'z'.repeat(30)).join(
    '\n',
  )
  const out = limitPrompt(c, prompt)
  const m = out.match(/^\[TRUNCATED: (\d+) chars left, read them from (.+prompt\.txt)\]\n\n/)
  const head = out.slice(m[0].length)
  assert.ok(head.endsWith('\n'))
  assert.equal(head + fs.readFileSync(m[2], 'utf8'), prompt)
  fs.rmSync(path.dirname(m[2]), { recursive: true, force: true })
})

test('limitPrompt falls back to truncation when the note cannot fit', () => {
  const c = fakeCompiler(40)
  const prompt = 'y'.repeat(5000)
  const out = limitPrompt(c, prompt)
  assert.ok(out.length <= 40)
  assert.match(out, /\[TRUNCATED/)
  assert.equal(c.lastPrompt.spilled === undefined || c.lastPrompt.spilled === 0, true)
  assert.ok(c.lastPrompt.dropped > 0)
})
