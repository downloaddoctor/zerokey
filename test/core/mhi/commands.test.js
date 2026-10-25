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

test('run grammar compiles to args', () => {
  const call = parser.parseBlock(body('cmd', { run: 'node --check server.js' }))
  assert.equal(call.tool, 'cmd')
  assert.deepEqual(call.params.args, ['node', '--check', 'server.js'])
})

test('till maps to timeout ms', () => {
  const call = parser.parseBlock(body('cmd', { run: 'echo hi', till: 5 }))
  assert.equal(call.params.timeout, 5000)
})

test('quoted run string retains spaces in one argument', () => {
  const call = parser.parseBlock(body('cmd', { run: 'echo "two words"' }))
  assert.deepEqual(call.params.args, ['echo', 'two words'])
})

test('program/args are rejected as non-canonical', () => {
  assert.throws(
    () => parser.parseBlock(body('cmd', { program: 'node', args: '[]' })),
    (e) => e.code === 'mhi_unknown_parameter',
  )
})

test('splitCommandString handles empty and whitespace', () => {
  assert.deepEqual(parser.splitCommandString(''), [])
  assert.deepEqual(parser.splitCommandString('   '), [])
  assert.deepEqual(parser.splitCommandString('git status --short'), ['git', 'status', '--short'])
})

test('splitCommandString handles mixed quoting', () => {
  assert.deepEqual(parser.splitCommandString("git commit -m 'fix bug'"), [
    'git',
    'commit',
    '-m',
    'fix bug',
  ])
})
