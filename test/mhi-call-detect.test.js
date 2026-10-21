'use strict'

const test = require('node:test')
const assert = require('node:assert')

const mhi = require('../core/mhi')
const SYNTAX = require('../engine/syntax')

const wrap = (...parts) => SYNTAX.OPEN + parts.join(SYNTAX.SEP) + SYNTAX.CLOSE

test('brackets that are not a known tool are prose, not calls', () => {
  for (const text of [
    'Syntax: ' + wrap('name', 'param=value') + ' per call.',
    'Unknown ' + wrap('cat', 'path=D:/x') + ' stays text.',
    'Unclosed ' + SYNTAX.OPEN + 'name and more prose',
  ]) {
    assert.strictEqual(mhi.evaluateAssistant(text).kind, 'final', text)
  }
})

test('a known tool is still a call, and real mixed output is still an error', () => {
  assert.strictEqual(mhi.evaluateAssistant(wrap('read', 'path=D:/x')).kind, 'calls')
  assert.strictEqual(
    mhi.evaluateAssistant('Sure. ' + wrap('read', 'path=D:/x')).reason,
    'mhi_mixed_output',
  )
})

test('an escaped close inside a value does not end the block early', () => {
  const body = 'a' + SYNTAX.ESC + SYNTAX.CLOSE + 'b'
  const decision = mhi.evaluateAssistant(wrap('write', 'path=D:/a.md', 'content=' + body))
  assert.strictEqual(decision.kind, 'calls')
  assert.strictEqual(decision.calls[0].params.content, 'a' + SYNTAX.CLOSE + 'b')
})
