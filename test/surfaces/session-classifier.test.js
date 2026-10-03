const { test } = require('node:test')
const assert = require('node:assert')

const {
  classifySession,
  isRealChatSession,
  resolveIde,
  DEFAULT_SURFACE,
} = require('../../utils/session-classifier')

const sys = (content) => [{ role: 'system', content }]

test('resolveIde maps each known prompt to its surface', () => {
  assert.strictEqual(resolveIde(sys('Follow Microsoft content policies. x')), 'copilot')
  assert.strictEqual(resolveIde(sys('You are an expert AI programming assistant')), 'vscode')
  assert.strictEqual(resolveIde(sys('You are Terax, an AI agent')), 'terax')
  assert.strictEqual(resolveIde(sys('You are opencode')), 'opencode')
})

test('unknown prompt falls back to the default surface and is not a real session', () => {
  const messages = sys('Generate a short title for this conversation')
  assert.strictEqual(resolveIde(messages), DEFAULT_SURFACE)
  assert.strictEqual(isRealChatSession(messages), false)
  assert.deepStrictEqual(classifySession(messages), {
    isReal: false,
    surface: DEFAULT_SURFACE,
    matched: null,
  })
})

test('an explicit fallback overrides the default for unmatched requests', () => {
  const messages = sys('Generate a short title for this conversation')
  assert.strictEqual(resolveIde(messages, 'terax'), 'terax')
})

test('missing/non-system first message is treated as not-real and uses the default surface', () => {
  assert.strictEqual(isRealChatSession([]), false)
  assert.strictEqual(resolveIde([]), DEFAULT_SURFACE)
  assert.strictEqual(isRealChatSession([{ role: 'user', content: 'hi' }]), false)
})

test('classifySession reports the matched surface for a real turn', () => {
  const result = classifySession(sys('Follow Microsoft content policies. x'))
  assert.deepStrictEqual(result, { isReal: true, surface: 'copilot', matched: 'copilot' })
})
