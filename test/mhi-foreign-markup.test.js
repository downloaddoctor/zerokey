'use strict'

const test = require('node:test')
const assert = require('node:assert')

const mhi = require('../core/mhi')
const SYNTAX = require('../engine/syntax')

const DSML =
  '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="replace">\n' +
  '<｜｜DSML｜｜ parameter name="path">a.md</｜｜DSML｜｜ parameter>\n' +
  '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'

test('DSML tool tags trigger an MHI repair round', () => {
  const decision = mhi.evaluateAssistant(DSML)
  assert.strictEqual(decision.kind, 'continue')
  assert.strictEqual(decision.reason, 'mhi_foreign_markup')
  assert.match(decision.prompt, /Do not use DSML/)
})

test('XML function_calls and invoke tags trigger a repair round', () => {
  for (const text of [
    '<function_calls><invoke name="read"></invoke></function_calls>',
    '<tool_call>{"name":"read"}</tool_call>',
  ]) {
    assert.strictEqual(mhi.evaluateAssistant(text).reason, 'mhi_foreign_markup')
  }
})

test('plain prose and valid MHI are unaffected', () => {
  assert.strictEqual(mhi.evaluateAssistant('All done.').kind, 'final')
  const calls = mhi.evaluateAssistant(SYNTAX.OPEN + 'ls' + SYNTAX.SEP + 'path=D:/x' + SYNTAX.CLOSE)
  assert.strictEqual(calls.kind, 'calls')
})
