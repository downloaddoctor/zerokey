'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { ephemeralSession } = require('../../utils/ephemeral-session')
const { StreamPipeline } = require('../../engine/pipeline')

test('ephemeralSession drops the real conversation id and parent id', () => {
  const real = { id: 'conv-real', parentId: 'msg-real', model: 'auto' }
  const clone = ephemeralSession(real)
  assert.equal(clone.id, null)
  assert.equal(clone.parentId, null)
  assert.equal(clone.model, 'auto')
  assert.equal(real.id, 'conv-real')
  assert.equal(real.parentId, 'msg-real')
})

test('ephemeralSession does not share usage totals with the real session', () => {
  const real = { id: 'c', _usageTotals: { total_tokens: 5, turns: 1, last: { total_tokens: 99 } } }
  const clone = ephemeralSession(real)
  clone._usageTotals.last.total_tokens = 1
  clone._usageTotals.total_tokens = 50
  assert.equal(real._usageTotals.last.total_tokens, 99)
  assert.equal(real._usageTotals.total_tokens, 5)
})

test('pipeline reports session.lastTokenUsage when a turn computes zero, however often', () => {
  const fake = Object.create(StreamPipeline.prototype)
  fake.tokenUsage = {}
  fake._modelChars = 0
  fake.session = { lastTokenUsage: 15 }
  fake.compiler = { lastPrompt: { chars: 0 } }
  for (let i = 0; i < 12; i += 1) {
    const usage = fake._turnUsage()
    assert.equal(usage.total_tokens, 15)
    assert.equal(usage.source, 'retained')
    fake.session.lastTokenUsage = usage.total_tokens
  }
})
