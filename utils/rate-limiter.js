const RATE_LIMIT = 2
const RATE_WINDOW = 5000 // ms
const INTERVAL = RATE_WINDOW / RATE_LIMIT // ms per call slot

/** @type {{[label]: lastCallAt}} */
const _state = {}

function acquireSlot(label = 'API') {
  const now = Date.now()
  const last = _state[label] ?? 0
  const elapsed = last > now ? 0 : now - last // guard against future timestamps
  const wait = Math.max(0, INTERVAL - elapsed)

  if (wait === 0) {
    _state[label] = now
    return
  }

  console.log(`[${label}] Rate limit hit — waiting ${(wait / 1000).toFixed(1)}s`)
  return new Promise((resolve) => {
    setTimeout(() => {
      _state[label] = Date.now()
      resolve()
    }, wait)
  })
}

module.exports = { acquireSlot }
