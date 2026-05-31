const RATE_LIMIT = 2
const RATE_WINDOW = 5000 // ms

const _windows = new Map()

function _getWindow(key) {
  if (!_windows.has(key)) _windows.set(key, [])
  return _windows.get(key)
}

function acquireSlot(label = 'API') {
  return new Promise((resolve) => {
    const timestamps = _getWindow(label)
    const tryAcquire = () => {
      const now = Date.now()
      while (timestamps.length && (timestamps[0] <= now - RATE_WINDOW || timestamps[0] > now)) {
        timestamps.shift()
      }
      if (timestamps.length < RATE_LIMIT) {
        timestamps.push(now)
        resolve()
        return
      }

      const wait = Math.min(RATE_WINDOW, Math.max(100, RATE_WINDOW - (now - timestamps[0])))
      console.log(`[${label}] Rate limit hit — waiting ${(wait / 1000).toFixed(1)}s`)
      setTimeout(tryAcquire, wait)
    }
    tryAcquire()
  })
}

module.exports = { acquireSlot }
