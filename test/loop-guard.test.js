const { test } = require('node:test')
const assert = require('node:assert')
const { inspectBatch, signature, MAX_BATCH } = require('../engine/loop-guard')
const { SEP } = require('../engine/syntax')

// ── signature ────────────────────────────────────────────────────────────

test('signature strips cap keys', () => {
  const a = signature(`glob${SEP}pattern=x${SEP}max=50`)
  const b = signature(`glob${SEP}pattern=x${SEP}max=200`)
  assert.strictEqual(a, b)
})

test('signature normalises the **/*X pattern variation', () => {
  const a = signature(`glob${SEP}pattern=**/a.md`)
  const b = signature(`glob${SEP}pattern=**/*a.md`)
  assert.strictEqual(a, b)
})

test('signature sorts args so order does not matter', () => {
  const a = signature(`read${SEP}path=x${SEP}from=5`)
  const b = signature(`read${SEP}from=5${SEP}path=x`)
  assert.strictEqual(a, b)
})

// ── dedup ────────────────────────────────────────────────────────────────

test('drops an exact self-duplicate', () => {
  const { deduped, selfDuplicates } = inspectBatch([`read${SEP}path=a`, `read${SEP}path=a`])
  assert.strictEqual(deduped.length, 1)
  assert.strictEqual(selfDuplicates, 1)
})

test('drops a cap-only variation', () => {
  const { deduped, selfDuplicates } = inspectBatch([
    `glob${SEP}pattern=x${SEP}max=50`,
    `glob${SEP}pattern=x${SEP}max=200`,
  ])
  assert.strictEqual(deduped.length, 1)
  assert.strictEqual(selfDuplicates, 1)
})

test('keeps distinct reads', () => {
  const { deduped, selfDuplicates } = inspectBatch([`read${SEP}path=a`, `read${SEP}path=b`])
  assert.strictEqual(deduped.length, 2)
  assert.strictEqual(selfDuplicates, 0)
})

test('non-read duplicates are kept (cmd rerun is intentional)', () => {
  const { deduped, selfDuplicates } = inspectBatch([`cmd${SEP}run=echo hi`, `cmd${SEP}run=echo hi`])
  assert.strictEqual(deduped.length, 2)
  assert.strictEqual(selfDuplicates, 0)
})

// ── drift signal ─────────────────────────────────────────────────────────

test('drifting is false on a clean small batch', () => {
  const { drifting } = inspectBatch([`read${SEP}path=a`, `read${SEP}path=b`, `ls${SEP}path=.`])
  assert.strictEqual(drifting, false)
})

test('drifting is true on a self-duplicate', () => {
  const { drifting } = inspectBatch([`read${SEP}path=a`, `read${SEP}path=a`])
  assert.strictEqual(drifting, true)
})

test(`drifting is true when deduped length exceeds ${MAX_BATCH}`, () => {
  const payloads = Array.from({ length: MAX_BATCH + 2 }, (_, i) => `read${SEP}path=f${i}`)
  const { deduped, oversized, drifting } = inspectBatch(payloads)
  assert.strictEqual(deduped.length, MAX_BATCH + 2)
  assert.strictEqual(oversized, true)
  assert.strictEqual(drifting, true)
})

test('exactly MAX_BATCH distinct calls is not oversized', () => {
  const payloads = Array.from({ length: MAX_BATCH }, (_, i) => `read${SEP}path=f${i}`)
  const { oversized, drifting } = inspectBatch(payloads)
  assert.strictEqual(oversized, false)
  assert.strictEqual(drifting, false)
})
