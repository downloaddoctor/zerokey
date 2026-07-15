const RATE_LIMIT = 5
const RATE_WINDOW = 15_000

// { [label]: { count, windowStart } }
const _state = {}

function acquireSlot(label = 'API', reset = false) {
  const now = Date.now()
  const s = _state[label] ?? (_state[label] = { count: 0, windowStart: now })

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

  console.log(`[${label}] ⚠ Rate limit — waiting ${(wait / 1000).toFixed(1)}s`)
  return new Promise((resolve) => {
    setTimeout(() => {
      s.count = 0
      s.windowStart = Date.now()
      s.count++
      resolve()
    }, wait)
  })
}

module.exports = { acquireSlot }
