'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { buildBody } = require('../../providers/inception/api')

test('buildBody: single prompt becomes one user message', () => {
  const b = buildBody({ prompt: 'hello', reasoningEffort: 'low' })
  assert.strictEqual(b.messages.length, 1)
  assert.strictEqual(b.messages[0].role, 'user')
  assert.strictEqual(b.messages[0].parts[0].text, 'hello')
  assert.strictEqual(b.reasoningEffort, 'low')
  assert.strictEqual(b.webSearchEnabled, false)
  assert.strictEqual(b.trigger, 'submit-message')
})

test('buildBody: message list encodes assistant parts with state=done', () => {
  const b = buildBody({
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b', reasoning: 'thinking' },
      { role: 'user', content: 'c' },
    ],
    reasoningEffort: 'High',
    webSearch: true,
  })
  assert.strictEqual(b.messages.length, 3)
  assert.strictEqual(b.messages[1].role, 'assistant')
  assert.strictEqual(b.messages[1].parts[0].type, 'reasoning')
  assert.strictEqual(b.messages[1].parts[0].text, 'thinking')
  assert.strictEqual(b.messages[1].parts[0].state, 'done')
  assert.strictEqual(b.messages[1].parts[1].type, 'text')
  assert.strictEqual(b.messages[1].parts[1].text, 'b')
  assert.strictEqual(b.reasoningEffort, 'high')
  assert.strictEqual(b.webSearchEnabled, true)
})

test('buildBody: messages wins over prompt when both are set', () => {
  const b = buildBody({
    prompt: 'ignored',
    messages: [{ role: 'user', content: 'taken' }],
  })
  assert.strictEqual(b.messages.length, 1)
  assert.strictEqual(b.messages[0].parts[0].text, 'taken')
})
