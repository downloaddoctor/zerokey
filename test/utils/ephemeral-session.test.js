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
