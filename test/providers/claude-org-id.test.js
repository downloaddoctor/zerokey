'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { ClaudeAPI } = require('../../providers/claude/api')
const { resolveTransport } = require('../../providers/claude/transport')

const ORG = 'e26f1e02-d573-4282-baa4-f6a21fb6d0bd'
const RPC_URL =
  'https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline'

async function orgOf(parsedFetch) {
  const api = new ClaudeAPI({})
  await api.initializeFromJSON(parsedFetch)
  return api._orgId
}

test('org id from legacy URL path', async () => {
  const url = `https://claude.ai/api/organizations/${ORG}/chat_conversations/abc/completion`
  assert.strictEqual(await orgOf({ url, headers: { cookie: 'a=b' }, body: {} }), ORG)
  assert.strictEqual(resolveTransport({ url }).name, 'completion')
})

test('org id from x-organization-uuid header on RPC capture', async () => {
  const headers = { cookie: 'a=b', 'x-organization-uuid': ORG }
  assert.strictEqual(await orgOf({ url: RPC_URL, headers, body: {} }), ORG)
})

test('org id from lastActiveOrg cookie when header is absent', async () => {
  const headers = { cookie: `a=b; lastActiveOrg=${ORG}; c=d` }
  assert.strictEqual(await orgOf({ url: RPC_URL, headers, body: {} }), ORG)
})

test('completion URL is built from the extracted org id', () => {
  const path = `/organizations/${ORG}/chat_conversations/x/completion`
  assert.strictEqual(
    `${ClaudeAPI.BASE_URL}${path}`,
    `https://claude.ai/api/organizations/${ORG}/chat_conversations/x/completion`,
  )
})
