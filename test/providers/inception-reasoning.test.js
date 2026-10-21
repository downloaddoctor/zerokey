'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { reasoning, models } = require('../../providers/inception/config')

test('inception reasoning map has a search variant for every effort', () => {
  for (const effort of ['Instant', 'Low', 'Medium', 'High']) {
    assert.deepEqual(reasoning.map[effort], { effort: effort.toLowerCase(), search: false })
    assert.deepEqual(reasoning.map[effort + ' Search'], {
      effort: effort.toLowerCase(),
      search: true,
    })
  }
})

test('inception reasoning labels match the map and the model list', () => {
  assert.deepEqual(reasoning.labels, Object.keys(reasoning.map))
  assert.deepEqual(models.models.mercury.reasoning, reasoning.labels)
})
