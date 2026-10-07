'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const usage = require('../../engine/usage')

test('accumulate stores the last turn split and ignores retained turns', () => {
  const session = {}
  usage.accumulate(session, {
    prompt_tokens: 8,
    completion_tokens: 3,
    total_tokens: 11,
    source: 'upstream',
  })
  usage.accumulate(session, {
    prompt_tokens: 11,
    completion_tokens: 0,
    total_tokens: 11,
    source: 'retained',
  })
  assert.deepEqual(session._usageTotals.last, {
    input_tokens: 8,
    output_tokens: 3,
    total_tokens: 11,
    source: 'upstream',
  })
  assert.equal(session._usageTotals.turns, 0)
})

test('normalizeUsage collapses all prompt-side spellings', () => {
  for (const key of [
    'prompt_tokens',
    'input_tokens',
    'prompt_token_count',
    'input_token_count',
    'promptTokens',
    'inputTokens',
  ]) {
    const result = usage.normalizeUsage({ [key]: 11, completion_tokens: 4 })
    assert.equal(result.promptTokens, 11, key + ' should be promptTokens')
  }
})

test('normalizeUsage collapses all completion-side spellings', () => {
  for (const key of [
    'completion_tokens',
    'output_tokens',
    'completion_token_count',
    'output_token_count',
    'completionTokens',
    'outputTokens',
  ]) {
    const result = usage.normalizeUsage({ prompt_tokens: 11, [key]: 7 })
    assert.equal(result.completionTokens, 7, key + ' should be completionTokens')
  }
})

test('normalizeUsage accepts string numbers', () => {
  const result = usage.normalizeUsage({ input_tokens: '9', output_tokens: '4' })
  assert.equal(result.promptTokens, 9)
  assert.equal(result.completionTokens, 4)
  assert.equal(result.totalTokens, 13)
})

test('normalizeUsage ignores a lying total and recomputes it', () => {
  const result = usage.normalizeUsage({
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 999,
  })
  assert.equal(result.totalTokens, 18)
})

test('normalizeUsage derives completion from total when prompt is known', () => {
  const result = usage.normalizeUsage({ prompt_tokens: 11, total_tokens: 20 })
  assert.equal(result.completionTokens, 9)
})

test('normalizeUsage derives prompt from total when completion is known', () => {
  const result = usage.normalizeUsage({ completion_tokens: 7, total_tokens: 20 })
  assert.equal(result.promptTokens, 13)
})

test('normalizeUsage returns null for empty input', () => {
  assert.equal(usage.normalizeUsage(null), null)
  assert.equal(usage.normalizeUsage({}), null)
  assert.equal(usage.normalizeUsage('nonsense'), null)
})

test('mergeUsage takes the maximum of each side', () => {
  let merged = null
  merged = usage.mergeUsage(merged, { prompt_tokens: 8 })
  merged = usage.mergeUsage(merged, { prompt_tokens: 10, completion_tokens: 3 })
  merged = usage.mergeUsage(merged, { prompt_tokens: 9, completion_tokens: 7 })
  assert.equal(merged.promptTokens, 10)
  assert.equal(merged.completionTokens, 7)
  assert.equal(merged.totalTokens, 17)
})

test('usageOfEvent finds nested usage', () => {
  const nested = usage.usageOfEvent({
    type: 'response.completed',
    response: { usage: { input_tokens: 15, output_tokens: 6 } },
  })
  assert.equal(nested.promptTokens, 15)
  assert.equal(nested.completionTokens, 6)
})

test('usageOfEvent finds usage under event.v', () => {
  const nested = usage.usageOfEvent({ v: { usage: { prompt_tokens: 5, completion_tokens: 3 } } })
  assert.equal(nested.promptTokens, 5)
  assert.equal(nested.completionTokens, 3)
})

test('estimateTokens: 8 ASCII bytes → 2 tokens, empty → 0', () => {
  assert.equal(usage.estimateTokens(''), 0)
  assert.equal(usage.estimateTokens('12345678'), 2)
})

test('buildUsage tags complete real usage as upstream', () => {
  const result = usage.buildUsage({ prompt_tokens: 11, completion_tokens: 7 }, null, 0)
  assert.equal(result.source, 'upstream')
  assert.equal(result.prompt_tokens, 11)
  assert.equal(result.completion_tokens, 7)
})

test('buildUsage tags partial real usage as mixed', () => {
  const result = usage.buildUsage({ prompt_tokens: 12 }, { chars: 100 }, 40)
  assert.equal(result.source, 'mixed')
  assert.equal(result.prompt_tokens, 12)
  assert.ok(result.completion_tokens > 0)
})

test('buildUsage tags no real usage as estimated', () => {
  const result = usage.buildUsage(null, { chars: 400 }, 80)
  assert.equal(result.source, 'estimated')
  assert.equal(result.estimated, true)
  assert.equal(result.prompt_tokens, 100)
  assert.equal(result.completion_tokens, 20)
})

test('buildUsage carries truncation state through from promptInfo', () => {
  const result = usage.buildUsage(null, { chars: 500, limit: 1000, headroom: 500, dropped: 0 }, 0)
  assert.equal(result.prompt_chars, 500)
  assert.equal(result.prompt_chars_limit, 1000)
  assert.equal(result.prompt_chars_headroom, 500)
  assert.equal(result.prompt_chars_dropped, 0)
})

test('accumulate only counts estimated turns', () => {
  const session = {}
  usage.accumulate(session, { source: 'upstream', prompt_tokens: 100, completion_tokens: 50 })
  assert.equal(usage.sessionTotals(session).turns, 0)
  usage.accumulate(session, {
    source: 'estimated',
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  })
  assert.equal(usage.sessionTotals(session).turns, 1)
  assert.equal(usage.sessionTotals(session).total_tokens, 15)
})

test('accumulate does not count mixed turns either', () => {
  const session = {}
  usage.accumulate(session, { source: 'mixed', prompt_tokens: 100, completion_tokens: 20 })
  assert.equal(usage.sessionTotals(session).turns, 0)
})

test('sessionTotals returns zeros for a fresh session', () => {
  const totals = usage.sessionTotals({})
  assert.equal(totals.prompt_tokens, 0)
  assert.equal(totals.turns, 0)
})

test('hasRealUsage is true only with both sides present', () => {
  assert.equal(usage.hasRealUsage({ prompt_tokens: 10, completion_tokens: 5 }), true)
  assert.equal(usage.hasRealUsage({ prompt_tokens: 10 }), false)
  assert.equal(usage.hasRealUsage(null), false)
})
