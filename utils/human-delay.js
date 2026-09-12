/**
 * Adds a randomized delay to mimic human-like pauses between actions.
 * This helps bypass basic bot-detection heuristics that look for perfectly timed, rapid-fire requests.
 *
 * @param {number} minMs - Minimum delay in milliseconds (default: 3000)
 * @param {number} maxMs - Maximum delay in milliseconds (default: 9000)
 * @returns {Promise<void>}
 */
async function humanDelay(minMs = 3000, maxMs = 9000) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
  await new Promise((resolve) => setTimeout(resolve, delay))
}

module.exports = { humanDelay }
