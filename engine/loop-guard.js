// Loop guard — dedupes one response's tool-call batch and tracks read
// signatures across turns to catch ABAB / ABA / AA loops.

const SYNTAX = require('./syntax')

const MAX_BATCH = 6

// Signature history cap across turns / rounds.
const MAX_HISTORY = 24

// Only pure-read tools are compared — a repeated command may be intentional.
const READ_ONLY = new Set(['read', 'ls', 'glob', 'grep', 'view_image'])

// Result caps are cosmetic: max=50 vs max=200 returns a superset.
const CAP_KEYS = /^(max|limit|till|timeout)$/

/**
 * Normalise one raw MHI payload to a comparable signature.
 * Returns null for non-read tools — they are never deduped.
 */
function signature(payload) {
  const parts = SYNTAX.splitPayload(String(payload)).filter(Boolean)
  const name = parts[0]
  if (!READ_ONLY.has(name)) return null
  const args = parts
    .slice(1)
    .map((a) => {
      const eq = a.indexOf('=')
      const k = eq === -1 ? a : a.slice(0, eq)
      const v = eq === -1 ? '' : a.slice(eq + 1)
      // Cosmetic: "**\/AGENTS.md" vs "**\/*AGENTS.md".
      if (k === 'pattern') return `${k}=${v.replace(/\*\*\/\*/g, '**/')}`
      return a
    })
    .filter((a) => a && !CAP_KEYS.test(a.split('=')[0]))
    .sort()
  return [name, ...args].join(SYNTAX.SEP)
}

/**
 * Inspect one response's tool-call batch.
 *
 * @param {string[]} payloads - raw MHI payloads in emission order
 * @returns {{deduped: string[], selfDuplicates: number, oversized: boolean, drifting: boolean}}
 */
function inspectBatch(payloads) {
  const seen = new Set()
  const deduped = []
  let selfDuplicates = 0

  for (const p of payloads) {
    const sig = signature(p)
    if (sig === null) {
      deduped.push(p)
      continue
    }
    if (seen.has(sig)) {
      selfDuplicates++
      continue
    }
    seen.add(sig)
    deduped.push(p)
  }

  const oversized = deduped.length > MAX_BATCH
  return {
    deduped,
    selfDuplicates,
    oversized,
    drifting: selfDuplicates > 0 || oversized,
  }
}

/**
 * Append the signatures of one batch to a history array, capped at
 * MAX_HISTORY entries. Only read-like calls (signature !== null) are
 * tracked — a repeated cmd may be intentional, a repeated read cannot be.
 *
 * @param {string[]} history
 * @param {string[]} payloads
 * @param {number} [cap]
 * @returns {string[]}
 */
function pushHistory(history, payloads, cap = MAX_HISTORY) {
  const next = Array.isArray(history) ? [...history] : []
  for (const p of payloads) {
    const sig = signature(p)
    if (sig !== null) next.push(sig)
  }
  if (next.length > cap) next.splice(0, next.length - cap)
  return next
}

/**
 * Detect a cross-turn / cross-round loop: every call in this batch repeats a
 * call already recorded in history (ABAB / ABA / AA). inspectBatch only sees
 * one response and cannot catch this — the exact pattern models fall into.
 *
 * @param {string[]} history - signatures from earlier batches
 * @param {string[]} payloads - raw MHI payloads of the current batch
 * @returns {{repeating: boolean, repeats: number}}
 */
function detectLoop(history, payloads) {
  const sigs = payloads.map(signature).filter((s) => s !== null)
  if (sigs.length === 0 || !Array.isArray(history) || history.length === 0) {
    return { repeating: false, repeats: 0 }
  }
  const known = new Set(history)
  const repeats = sigs.filter((s) => known.has(s)).length
  return { repeating: repeats === sigs.length, repeats }
}

module.exports = {
  detectLoop,
  inspectBatch,
  pushHistory,
  signature,
  MAX_BATCH,
  MAX_HISTORY,
}
