'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const registry = require('../../surfaces/registry')
const { classifySession } = require('../../utils/session-classifier')

test('openai surface exposes identity-mapped tools', () => {
  const { tools, reverseMap } = registry.get('openai')

  // Every generic tool maps to itself as the native name (identity).
  for (const [generic, cfg] of Object.entries(tools)) {
    assert.strictEqual(cfg.tool, generic, `openai.${generic}: native should equal generic`)
    assert.strictEqual(reverseMap[generic], generic, `reverseMap[${generic}]`)
  }

  // Spot-check the tools a plain OpenAI client is expected to drive.
  for (const name of [
    'read',
    'write',
    'replace',
    'ls',
    'glob',
    'grep',
    'cmd',
    'view_image',
    'todos_add',
    'todos_set',
    'ask',
  ]) {
    assert.ok(tools[name], `openai: missing tool ${name}`)
  }
})

test('openai surface is never auto-matched by system-prompt prefix', () => {
  // A system prompt that is not any IDE surface does not resolve to 'openai'.
  const matched = registry.resolveSurface([{ role: 'system', content: 'You are helpful.' }])
  assert.strictEqual(matched, null)
})

test('classifySession routes no-fingerprint requests to openai as real turns', () => {
  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Read package.json.' },
  ]

  const result = classifySession(messages)
  assert.strictEqual(result.surface, 'openai')
  assert.strictEqual(result.isReal, true)
  assert.strictEqual(result.matched, 'openai')
})

test('classifySession prefers a real IDE surface over openai', () => {
  const vscodePrefix = 'You are an expert AI programming assistant'
  const messages = [{ role: 'system', content: vscodePrefix + ' — and more.' }]

  const result = classifySession(messages)
  assert.strictEqual(result.surface, 'vscode')
  assert.strictEqual(result.isReal, true)
})
