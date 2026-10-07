'use strict'

/**
 * Shared HTTP failure helper for provider API clients (BaseAPI subclasses
 * and the standalone ChatGPT/Qwen clients). The thrown error carries `.status`,
 * which retry.classify and classifyError depend on.
 */

/**
 * Throw an Error with `.status` when `res` is not OK, unless its status is in
 * `allow` (e.g. 404 on delete). One line replaces the manual `if (!res.ok)` blocks.
 */
async function assertOk(res, { allow = [], prefix = '' } = {}) {
  if (res.ok || allow.includes(res.status)) return
  const text = await res.text().catch((caughtErr) => {
    console.error('res.text() failed:', caughtErr)
    return ''
  })
  const error = new Error(`${prefix}HTTP ${res.status}: ${text.slice(0, 200)}`)
  error.status = res.status
  throw error
}

module.exports = { assertOk }
