'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const parser = require('../../../core/mhi/parser')
const SYNTAX = require('../../../engine/syntax')

const S = SYNTAX.SEP

function body(name, params = {}) {
  let out = name
  for (const [k, v] of Object.entries(params)) out += S + k + '=' + v
  return out
}

function wrap(name, params = {}) {
  return SYNTAX.OPEN + body(name, params) + SYNTAX.CLOSE
}

test('read requires path', () => {
  assert.throws(
    () => parser.parseBlock('read'),
    (e) => e.code === 'mhi_missing_parameter',
  )
})

test('read accepts from and to as integers', () => {
  const call = parser.parseBlock(body('read', { path: 'x', from: 5, to: 20 }))
  assert.equal(call.tool, 'read')
  assert.equal(call.params.from, 5)
  assert.equal(call.params.to, 20)
})

test('read refuses to < from', () => {
  assert.throws(
    () => parser.parseBlock(body('read', { path: 'x', from: 20, to: 5 })),
    (e) => e.code === 'mhi_invalid_range',
  )
})

test('unknown tool throws', () => {
  assert.throws(
    () => parser.parseBlock(body('nope', { a: 1 })),
    (e) => e.code === 'mhi_unknown_tool',
  )
})

test('unknown parameter throws with allowed list', () => {
  assert.throws(
    () => parser.parseBlock(body('read', { path: 'x', bogus: 1 })),
    (e) => e.code === 'mhi_unknown_parameter' && e.message.includes('path'),
  )
})

test('duplicate parameter throws', () => {
  assert.throws(
    () => parser.parseBlock(body('read', { path: 'x' }) + S + 'path=y'),
    (e) => e.code === 'mhi_duplicate_parameter',
  )
})

test('grep requires exactly one of query or queryR', () => {
  assert.throws(
    () => parser.parseBlock('grep'),
    (e) => e.code === 'mhi_parameter_conflict',
  )
  assert.throws(
    () => parser.parseBlock(body('grep', { query: 'a' }) + S + 'queryR=b'),
    (e) => e.code === 'mhi_parameter_conflict',
  )
})

test('cmd requires program', () => {
  assert.throws(
    () => parser.parseBlock(body('cmd', { args: '[]' })),
    (e) => e.code === 'mhi_missing_parameter',
  )
})

test('parseAssistantText returns text for no blocks', () => {
  assert.equal(parser.parseAssistantText('plain answer').kind, 'text')
})

test('parseAssistantText returns calls for a single block', () => {
  const result = parser.parseAssistantText(wrap('read', { path: 'x' }))
  assert.equal(result.kind, 'calls')
  assert.equal(result.calls.length, 1)
})

test('parseAssistantText marks mixed output', () => {
  const result = parser.parseAssistantText('text ' + wrap('read', { path: 'x' }))
  assert.equal(result.kind, 'text')
  assert.equal(result.mixed, true)
})

test('parseAssistantText refuses an incomplete block', () => {
  assert.throws(
    () => parser.parseAssistantText(SYNTAX.OPEN + 'read' + S + 'path=x'),
    (e) => e.code === 'mhi_incomplete_block',
  )
})

test('parseAssistantText refuses more than MAX_BLOCKS', () => {
  const one = wrap('read', { path: 'x' })
  assert.throws(
    () => parser.parseAssistantText(one.repeat(parser.MAX_BLOCKS + 1)),
    (e) => e.code === 'mhi_too_many_blocks',
  )
})
