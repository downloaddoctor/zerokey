'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const parser = require('../../../core/mhi/parser')
const SYNTAX = require('../../../engine/syntax')

const S = SYNTAX.SEP
const wrap = (body) => SYNTAX.OPEN + body + SYNTAX.CLOSE

test('multiple run keys expand to one call each', () => {
  const out = parser.parseAssistantText(
    wrap('cmd' + S + 'run=git status --short' + S + 'run=git diff --staged' + S + 'run=git diff'),
  )
  assert.equal(out.kind, 'calls')
  assert.equal(out.calls.length, 3)
  assert.deepEqual(out.calls[1].params.args, ['git', 'diff', '--staged'])
})

test('till applies to the run before it', () => {
  const out = parser.parseAssistantText(
    wrap('cmd' + S + 'run=npm test' + S + 'till=60' + S + 'run=git status'),
  )
  assert.equal(out.calls[0].params.timeout, 60000)
  assert.equal(out.calls[1].params.timeout, undefined)
})

test('till before any run is rejected', () => {
  assert.throws(
    () => parser.parseBlock('cmd' + S + 'till=5' + S + 'run=ls'),
    (e) => e.code === 'mhi_missing_parameter',
  )
})

test('till=0 is out of range', () => {
  assert.throws(
    () => parser.parseBlock('cmd' + S + 'run=ls' + S + 'till=0'),
    (e) => e.code === 'mhi_parameter_out_of_range',
  )
})

test('parseBlock refuses a block holding several commands', () => {
  assert.throws(
    () => parser.parseBlock('cmd' + S + 'run=a' + S + 'run=b'),
    (e) => e.code === 'mhi_parameter_conflict',
  )
})
