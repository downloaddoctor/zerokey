/**
 * Adds a randomized delay to mimic human-like pauses between actions.
 * This helps bypass basic bot-detection heuristics that look for perfectly timed, rapid-fire requests.
 *
 * @param {number} minMs - Minimum delay in milliseconds (default: 3000)
 * @param {number} maxMs - Maximum delay in milliseconds (default: 9000)
 * @returns {Promise<void>}
 */
const { tickWait } = require('./log')

async function humanDelay(minMs = 3000, maxMs = 9000) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
  const stopTick = tickWait('HUMAN', delay)
  await new Promise((resolve) => setTimeout(resolve, delay))
  stopTick()
}

module.exports = { humanDelay }
