const { test } = require('node:test')
const assert = require('node:assert')

const { classifySession, isRealChatSession, resolveIde } = require('../utils/session-classifier')

const sys = (content) => [{ role: 'system', content }]

test('resolveIde maps each known prompt to its surface', () => {
  assert.strictEqual(resolveIde('vscode', sys('Follow Microsoft content policies. x')), 'copilot')
  assert.strictEqual(
    resolveIde('vscode', sys('You are an expert AI programming assistant')),
    'vscode',
  )
  assert.strictEqual(resolveIde('terax', sys('You are Terax, an AI agent')), 'terax')
  assert.strictEqual(resolveIde('opencode', sys('You are opencode')), 'opencode')
})

test('unknown prompt falls back to the header ide and is not a real session', () => {
  const messages = sys('Generate a short title for this conversation')
  assert.strictEqual(resolveIde('vscode', messages), 'vscode')
  assert.strictEqual(isRealChatSession('vscode', messages), false)
  assert.deepStrictEqual(classifySession('vscode', messages), {
    isReal: false,
    surface: 'vscode',
    matched: null,
  })
})

test('missing/non-system first message is treated as not-real and keeps the header ide', () => {
  assert.strictEqual(isRealChatSession('vscode', []), false)
  assert.strictEqual(resolveIde('vscode', []), 'vscode')
  assert.strictEqual(isRealChatSession('vscode', [{ role: 'user', content: 'hi' }]), false)
})

test('classifySession reports the matched surface for a real turn', () => {
  const result = classifySession('vscode', sys('Follow Microsoft content policies. x'))
  assert.deepStrictEqual(result, { isReal: true, surface: 'copilot', matched: 'copilot' })
})
