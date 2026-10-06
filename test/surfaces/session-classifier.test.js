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

test('unknown prompt without tools is an ephemeral openai call', () => {
  const messages = sys('Generate a short title for this conversation')
  assert.strictEqual(resolveIde(messages), DEFAULT_SURFACE)
  assert.strictEqual(isRealChatSession(messages), false)
  assert.deepStrictEqual(classifySession(messages), {
    isReal: false,
    surface: DEFAULT_SURFACE,
    matched: DEFAULT_SURFACE,
  })
})

test('unknown prompt with tools[] is a real openai turn', () => {
  const messages = sys('You are helpful.')
  const tools = [{ type: 'function', function: { name: 'read' } }]
  assert.deepStrictEqual(classifySession(messages, { tools }), {
    isReal: true,
    surface: DEFAULT_SURFACE,
    matched: DEFAULT_SURFACE,
  })
})

test('known utility prompts stay ephemeral even when tools[] is present', () => {
  const messages = sys(
    'You are an expert in crafting ultra-compact titles for chatbot conversations.',
  )
  const tools = [{ type: 'function', function: { name: 'read' } }]
  assert.strictEqual(classifySession(messages, { tools }).isReal, false)
})

test('progress-message utility prompt stays ephemeral even when tools[] is present', () => {
  const messages = sys(
    'You are an expert in writing short, catchy, and encouraging progress messages for a coding assistant.',
  )
  const tools = [{ type: 'function', function: { name: 'read' } }]
  assert.strictEqual(classifySession(messages, { tools }).isReal, false)
})

test('an explicit fallback is accepted but the same surface is returned', () => {
  // The old per-call fallback is no longer meaningful: everything without an
  // IDE fingerprint maps to the single openai surface.
  const messages = sys('Generate a short title for this conversation')
  assert.strictEqual(resolveIde(messages, 'terax'), 'openai')
})

test('missing/non-system first message resolves to the default surface as an ephemeral call', () => {
  assert.strictEqual(isRealChatSession([]), false)
  assert.strictEqual(resolveIde([]), DEFAULT_SURFACE)
  assert.strictEqual(isRealChatSession([{ role: 'user', content: 'hi' }]), false)
})

test('classifySession reports the matched surface for a real turn', () => {
  const result = classifySession(sys('Follow Microsoft content policies. x'))
  assert.deepStrictEqual(result, { isReal: true, surface: 'copilot', matched: 'copilot' })
})
