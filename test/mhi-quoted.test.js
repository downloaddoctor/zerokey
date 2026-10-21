'use strict'

const test = require('node:test')
const assert = require('node:assert')

const mhi = require('../core/mhi')
const SYNTAX = require('../engine/syntax')

const block = SYNTAX.OPEN + 'read' + SYNTAX.SEP + 'path=D:/x' + SYNTAX.CLOSE

test('a backtick right before the open bracket makes it text, like the stream scanner', () => {
  for (const text of ['Use `' + block + '` to read.', '```\n`' + block + '\n```']) {
    assert.strictEqual(mhi.evaluateAssistant(text).kind, 'final', text)
  }
})

test('fences and quotes alone do not hide a known tool call', () => {
  assert.strictEqual(mhi.evaluateAssistant('Call "' + block + '" now.').reason, 'mhi_mixed_output')
  assert.strictEqual(mhi.evaluateAssistant(block).kind, 'calls')
})

test('backticks inside a real block value do not hide the block', () => {
  const write =
    SYNTAX.OPEN +
    'write' +
    SYNTAX.SEP +
    'path=D:/a.md' +
    SYNTAX.SEP +
    'content=```js\nx\n```' +
    SYNTAX.CLOSE
  const decision = mhi.evaluateAssistant(write)
  assert.strictEqual(decision.kind, 'calls')
  assert.strictEqual(decision.calls[0].params.content, '```js\nx\n```')
})
