'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { runToolLoop } = require('../core/mhi/loop')

const CONFIG = {
  MHI_MAX_ROUNDS: 4,
  MHI_FILE_TOOLS: true,
  MHI_VIEW_IMAGE: false,
  MHI_CMD_TOOLS: false,
  WORKSPACE_ROOTS: [],
}

test('repair round sends only the parser error, not the old history again', async () => {
  const seen = []
  const replies = ['<function_calls><invoke name="read"></invoke></function_calls>', 'done']
  await runToolLoop({
    payload: {
      messages: [
        { role: 'assistant', content: 'earlier' },
        { role: 'tool', content: 'The user cancelled the tool call.' },
        { role: 'user', content: 'use dsml' },
      ],
    },
    pipeline: {},
    config: CONFIG,
    turn: async (payload) => {
      seen.push(payload.messages)
      return { assistantText: replies[seen.length - 1] }
    },
  })

  assert.strictEqual(seen.length, 2)
  const second = seen[1]
  const lastAssistant = second.map((m) => m.role).lastIndexOf('assistant')
  const sent = second.slice(lastAssistant + 1)
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(sent[0].role, 'mhi')
  assert.match(sent[0].content, /mhi_foreign_markup/)
})
