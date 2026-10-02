// Loop guard — inspects one response's tool-call batch before it reaches the IDE.
// Drops self-duplicate read calls; flags the session when the model repeats
// itself or emits more than the 6-call cap, so the next turn carries a reminder.

const SYNTAX = require('./syntax')

const MAX_BATCH = 6

// Only pure-read tools are compared — a repeated command may be intentional.
const READ_ONLY = new Set(['read', 'ls', 'glob', 'grep', 'view_image'])

// Result caps carry no meaning for comparison: glob max=50 vs max=200 returns
// a superset, but the second call is redundant once the first result is in.
const CAP_KEYS = /^(max|limit|till|timeout)$/

/**
 * Normalise one raw MHI payload to a comparable signature.
 * Returns null for non-read tools — they are never deduped.
 */
function signature(payload) {
  // splitPayload honours escapes, so a value containing an escaped separator
  // still splits correctly.
  const parts = SYNTAX.splitPayload(String(payload)).filter(Boolean)
  const name = parts[0]
  if (!READ_ONLY.has(name)) return null
  const args = parts
    .slice(1)
    .map((a) => {
      const eq = a.indexOf('=')
      const k = eq === -1 ? a : a.slice(0, eq)
      const v = eq === -1 ? '' : a.slice(eq + 1)
      // Cosmetic variation observed across rounds: "**\/AGENTS.md" vs "**\/*AGENTS.md".
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

module.exports = { inspectBatch, signature, MAX_BATCH }
