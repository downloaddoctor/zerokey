const RATE_LIMIT = 5
const RATE_WINDOW = 15_000

// { [label]: { count, windowStart, cooldownUntil } }
const _state = {}

// Known provider labels — used only for documentation. Actual labels are
// passed at call sites (deepseek, claude, chatgpt, qwen) and
// created on demand in acquireSlot.
const KNOWN_LABELS = new Set(['DeepSeek', 'Claude', 'ChatGPT', 'Qwen'])

/**
 * Block all future acquires for `label` until `Date.now() + ms`.
 * Called by provider APIs when they receive a 429 from the upstream server.
 * The cooldown overrides the normal 5/15s window — all requests wait until
 * the cooldown expires, then the counter resets.
 */
function setProviderCooldown(label, ms) {
  const s = _state[label] ?? (_state[label] = { count: 0, windowStart: 0 })
  s.cooldownUntil = Date.now() + ms
  s.count = RATE_LIMIT // force any in-flight acquires to wait
  console.warn(`[${label}] ⚠ Provider 429 — cooldown ${(ms / 1000).toFixed(1)}s`)
}

function acquireSlot(label = 'API', reset = false) {
  const now = Date.now()
  const s = _state[label] ?? (_state[label] = { count: 0, windowStart: now })

  // provider-imposed cooldown takes priority over normal window
  if (s.cooldownUntil && now < s.cooldownUntil) {
    const wait = s.cooldownUntil - now
    console.warn(`[${label}] ⚠ Provider cooldown — waiting ${(wait / 1000).toFixed(1)}s`)
    return new Promise((resolve) => {
      setTimeout(() => {
        s.count = 0
        s.windowStart = Date.now()
        s.cooldownUntil = 0
        s.count++
        resolve()
      }, wait)
    })
  }
  // clear stale cooldown
  if (s.cooldownUntil) s.cooldownUntil = 0

  // reset window if expired or windowStart is in the future (clock skew)
  if (now - s.windowStart >= RATE_WINDOW || s.windowStart > now) {
    s.count = 0
    s.windowStart = now
  }

  const wait = reset
    ? RATE_WINDOW
    : s.count < RATE_LIMIT
      ? 0
      : Math.max(0, RATE_WINDOW - (now - s.windowStart))

  if (wait === 0) {
    s.count++
    return Promise.resolve()
  }

  console.warn(`[${label}] ⚠ Rate limit — waiting ${(wait / 1000).toFixed(1)}s`)
  return new Promise((resolve) => {
    setTimeout(() => {
      s.count = 0
      s.windowStart = Date.now()
      s.count++
      resolve()
    }, wait)
  })
}

module.exports = { acquireSlot, setProviderCooldown, KNOWN_LABELS }
