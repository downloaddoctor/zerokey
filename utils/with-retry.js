'use strict'

/**
 * Shared bounded retry for provider routers.
 *
 * Classifies failures via utils/retry.js, drains discarded response bodies,
 * sleeps with backoff honouring Retry-After, and aborts cleanly on the
 * caller's signal. Depth is maxAttempts from the classification.
 *
 * All five provider routers use this single implementation.
 */

const retry = require('./retry')
const { acquireSlot } = require('./rate-limiter')

/**
 * @param {Function} fn - returns a promise; the thing being retried
 * @param {object} [opts]
 * @param {object} [opts.pipeline] - StreamPipeline (for .signal and logging)
 * @param {string} [opts.label] - provider label for log lines
 * @param {Function} [opts.isTerminal] - extra (error) => boolean; true stops retries
 */
async function withRetry(fn, opts = {}) {
  const { pipeline, label = 'Provider', isTerminal } = opts
  const signal = pipeline && pipeline.signal

  let attempt = 0
  for (;;) {
    attempt += 1
    await acquireSlot(label)
    try {
      return await fn()
    } catch (error) {
      console.error(`[${label}] request failed:`, error)
      if (isTerminal && isTerminal(error)) throw error
      const policy = retry.classify(error, signal)
      if (!policy.retry || attempt >= policy.maxAttempts) throw error
      retry.discardResponse(error.response)
      const delay = retry.delayMs(attempt, error.response)
      console.warn(
        `[${label}] Retrying after ${policy.kind} (attempt ${attempt + 1}/${policy.maxAttempts}, wait ${delay}ms)`,
      )
      await retry.sleep(delay, signal)
    }
  }
}

module.exports = { withRetry }
