// Rate limiter: 5 calls per 10 seconds, queues excess
const RATE_LIMIT = 5
const RATE_WINDOW = 10000 // ms
const callTimestamps = []

function acquireSlot(label = 'API') {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      const now = Date.now()
      while (callTimestamps.length && callTimestamps[0] <= now - RATE_WINDOW) {
        callTimestamps.shift()
      }
      if (callTimestamps.length < RATE_LIMIT) {
        callTimestamps.push(now)
        resolve()
      } else {
        const wait = RATE_WINDOW - (now - callTimestamps[0])
        console.log(`[${label}] Rate limit hit — waiting ${(wait / 1000).toFixed(1)}s`)
        setTimeout(tryAcquire, wait)
      }
    }
    tryAcquire()
  })
}

module.exports = { acquireSlot }
