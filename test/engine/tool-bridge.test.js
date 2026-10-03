'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const bridge = require('../../engine/tool-bridge')
const SYNTAX = require('../../engine/syntax')

function blk(name, params = {}) {
  let out = SYNTAX.OPEN + name
  for (const [k, v] of Object.entries(params)) out += SYNTAX.SEP + k + '=' + v
  return out + SYNTAX.CLOSE
}

const SAMPLE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          from: { type: 'integer' },
          to: { type: 'integer' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search text',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          glob: { type: 'string' },
          max: { type: 'integer' },
        },
        required: ['query'],
      },
    },
  },
]

test('preparePayload is a no-op without tools', () => {
  const payload = { messages: [{ role: 'user', content: 'hello' }] }
  const out = bridge.preparePayload(payload)
  assert.equal(out.messages[0].content, 'hello')
})

test('preparePayload injects grammar into the last user message', () => {
  const payload = { tools: SAMPLE_TOOLS, messages: [{ role: 'user', content: 'hi' }] }
  const out = bridge.preparePayload(payload)
  assert.match(out.messages[0].content, /<mhi_tools>/)
  assert.match(out.messages[0].content, /read/)
  assert.match(out.messages[0].content, /grep/)
  assert.match(out.messages[0].content, /hi$/)
})

test('preparePayload does not double-inject', () => {
  const once = bridge.preparePayload({
    tools: SAMPLE_TOOLS,
    messages: [{ role: 'user', content: 'hi' }],
  })
  const twice = bridge.preparePayload(once)
  const count = (twice.messages[0].content.match(/<mhi_tools>/g) || []).length
  assert.equal(count, 1)
})

test('grammar block marks required and optional parameters', () => {
  const registry = bridge.buildRegistry(SAMPLE_TOOLS)
  const grammar = bridge.grammarBlock(registry.entries)
  assert.match(grammar, /path=\{str\}/)
  assert.match(grammar, /\(.*from=\{int\}.*\)\?/)
})

test('evaluateAssistant returns final when no block is present', () => {
  const result = bridge.evaluateAssistant('plain text', { tools: SAMPLE_TOOLS })
  assert.equal(result.kind, 'final')
  assert.equal(result.text, 'plain text')
})

test('evaluateAssistant parses a single block into a tool call', () => {
  const result = bridge.evaluateAssistant(blk('read', { path: 'C:\\a.txt' }), {
    tools: SAMPLE_TOOLS,
  })
  assert.equal(result.kind, 'calls')
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].function.name, 'read')
  const args = JSON.parse(result.calls[0].function.arguments)
  assert.equal(args.path, 'C:\\a.txt')
})

test('evaluateAssistant coerces integer parameters', () => {
  const result = bridge.evaluateAssistant(blk('read', { path: 'x.txt', from: 5, to: 20 }), {
    tools: SAMPLE_TOOLS,
  })
  assert.equal(result.kind, 'calls')
  const args = JSON.parse(result.calls[0].function.arguments)
  assert.equal(args.from, 5)
  assert.equal(args.to, 20)
})

test('evaluateAssistant refuses mixed text and blocks', () => {
  const text = 'Working on it. ' + blk('read', { path: 'x.txt' })
  const result = bridge.evaluateAssistant(text, { tools: SAMPLE_TOOLS })
  assert.equal(result.kind, 'continue')
  assert.equal(result.reason, 'mixed_output')
})

test('evaluateAssistant refuses an incomplete block', () => {
  const text = SYNTAX.OPEN + 'read' + SYNTAX.SEP + 'path=x.txt'
  const result = bridge.evaluateAssistant(text, { tools: SAMPLE_TOOLS })
  assert.equal(result.kind, 'continue')
  assert.equal(result.reason, 'incomplete_block')
})

test('evaluateAssistant refuses a batch over MAX_CALLS', () => {
  const text = blk('read', { path: 'x.txt' }).repeat(bridge.MAX_CALLS + 1)
  const result = bridge.evaluateAssistant(text, { tools: SAMPLE_TOOLS })
  assert.equal(result.kind, 'continue')
  assert.equal(result.reason, 'too_many_calls')
})

test('evaluateAssistant passes unknown tools through', () => {
  const result = bridge.evaluateAssistant(blk('custom_tool', { foo: 'bar' }), {
    tools: SAMPLE_TOOLS,
  })
  assert.equal(result.kind, 'calls')
  assert.equal(result.calls[0].function.name, 'custom_tool')
  assert.equal(JSON.parse(result.calls[0].function.arguments).foo, 'bar')
})

test('evaluateAssistant honours the escape sequence', () => {
  const BS = String.fromCharCode(0x5c)
  const text =
    SYNTAX.OPEN + 'read' + SYNTAX.SEP + 'path=a' + BS + SYNTAX.SEP + 'b.txt' + SYNTAX.CLOSE
  const result = bridge.evaluateAssistant(text, { tools: SAMPLE_TOOLS })
  assert.equal(result.kind, 'calls')
  const args = JSON.parse(result.calls[0].function.arguments)
  assert.equal(args.path, 'a' + SYNTAX.SEP + 'b.txt')
})

test('evaluateAssistant parses multiple blocks', () => {
  const text = blk('read', { path: 'a.txt' }) + blk('read', { path: 'b.txt' })
  const result = bridge.evaluateAssistant(text, { tools: SAMPLE_TOOLS })
  assert.equal(result.kind, 'calls')
  assert.equal(result.calls.length, 2)
})

test('parseBlock returns null on a duplicate key', () => {
  const body = 'read' + SYNTAX.SEP + 'path=a' + SYNTAX.SEP + 'path=b'
  assert.equal(bridge.parseBlock(body), null)
})
