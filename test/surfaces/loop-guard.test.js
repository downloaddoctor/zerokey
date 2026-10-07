const { test } = require('node:test')
const assert = require('node:assert')
const {
  detectLoop,
  inspectBatch,
  pushHistory,
  signature,
  MAX_BATCH,
  MAX_HISTORY,
} = require('../../engine/loop-guard')
const { SEP } = require('../../engine/syntax')

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

// ── pushHistory ──────────────────────────────────────────────────────────

test('pushHistory appends read signatures and caps length', () => {
  let h = []
  for (let i = 0; i < MAX_HISTORY + 5; i += 1) {
    h = pushHistory(h, [`read${SEP}path=f${i}`])
  }
  assert.strictEqual(h.length, MAX_HISTORY)
  assert.strictEqual(h[h.length - 1], signature(`read${SEP}path=f${MAX_HISTORY + 4}`))
})

test('pushHistory ignores non-read tools', () => {
  const h = pushHistory([], [`cmd${SEP}run=x`, `read${SEP}path=a`])
  assert.strictEqual(h.length, 1)
})

// ── detectLoop (cross-turn / cross-round) ────────────────────────────────

test('detectLoop flags an ABAB repeat across batches', () => {
  let h = []
  h = pushHistory(h, [`read${SEP}path=a`, `read${SEP}path=b`])
  const { repeating } = detectLoop(h, [`read${SEP}path=a`, `read${SEP}path=b`])
  assert.strictEqual(repeating, true)
})

test('detectLoop flags a single A repeat', () => {
  const h = pushHistory([], [`read${SEP}path=a`])
  const { repeating } = detectLoop(h, [`read${SEP}path=a`])
  assert.strictEqual(repeating, true)
})

test('detectLoop is false on a genuinely new read', () => {
  const h = pushHistory([], [`read${SEP}path=a`])
  const { repeating } = detectLoop(h, [`read${SEP}path=b`])
  assert.strictEqual(repeating, false)
})

test('detectLoop ignores empty history and empty batch', () => {
  assert.strictEqual(detectLoop([], [`read${SEP}path=a`]).repeating, false)
  assert.strictEqual(detectLoop([signature(`read${SEP}path=a`)], []).repeating, false)
})

test('detectLoop is false for a repeated cmd (intentional rerun)', () => {
  const h = pushHistory([], [`cmd${SEP}run=x`])
  const { repeating } = detectLoop(h, [`cmd${SEP}run=x`])
  assert.strictEqual(repeating, false)
})
