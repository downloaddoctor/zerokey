'use strict'

/**
 * ChatGPT-specific recovery helpers.
 *
 * Wraps a ChatGPTAPI instance with:
 *
 *   - `withAuthRecovery(fn)`   — runs fn once; on HTTP 401, forces a full
 *     re-decode of the browser capture (fresh authorization + cookies) and
 *     retries exactly once. A second 401 is terminal.
 *   - `refreshSentinelSafe()`  — refreshes sentinel + conduit ahead of a turn
 *     and swallows failures that only affect a follow-up attempt (a stale
 *     token from the same process is still usable for the current request).
 *
 * The module never touches request bodies; it only inspects HTTP status and
 * header names.
 */

const fs = require('fs')
const path = require('path')

const ONE_SHOT_401 = 'chatgpt_401_retry_used'

function isUnauthorized(error) {
  if (!error) return false
  const status =
    Number.isInteger(error.status) && error.status > 0
      ? error.status
      : Number.isInteger(error.statusCode) && error.statusCode > 0
        ? error.statusCode
        : null
  return status === 401
}

/**
 * Force-reload the browser capture from disk so the client re-seeds headers
 * and cookies. The capture file is the source of truth; the process keeps no
 * backstop copy.
 */
async function forceReloadCapture(api) {
  const file = path.join(__dirname, '..', '..', 'temp', 'users.json')
  let data = null
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, reason: 'no_users_file' }
    return { ok: false, reason: 'users_file_unreadable' }
  }

  // Walk the tree looking for a parsedFetch whose provider matches this API.
  // The selector's JSON shape is { <provider>: { <username>: { parsedFetch } } }.
  const provider = api && api._providerKey ? api._providerKey : 'chatgpt'
  const bucket = data && data[provider]
  if (!bucket || typeof bucket !== 'object') return { ok: false, reason: 'provider_missing' }

  for (const username of Object.keys(bucket)) {
    const entry = bucket[username]
    if (!entry || !entry.parsedFetch) continue
    try {
      await api.initializeFromJSON(entry.parsedFetch)
      return { ok: true, username }
    } catch (error) {
      console.warn(
        'Force-reload of capture failed for user ' + username + ': ' + (error.message || error),
      )
    }
  }
  return { ok: false, reason: 'no_parsed_fetch' }
}

/**
 * Run fn() once. On 401, force-reload the capture and retry exactly once.
 * A second 401 propagates to the caller.
 */
async function withAuthRecovery(api, fn) {
  try {
    return await fn()
  } catch (error) {
    if (!isUnauthorized(error)) throw error

    console.warn('ChatGPT returned 401; forcing a capture reload and retrying once.')
    const reload = await forceReloadCapture(api)
    if (!reload.ok) {
      const wrapped = new Error(
        'ChatGPT returned 401 and the browser capture could not be reloaded (' +
          reload.reason +
          ').',
      )
      wrapped.status = 401
      wrapped.statusCode = 401
      wrapped.code = 'chatgpt_401_recovery_failed'
      throw wrapped
    }
    if (api[ONE_SHOT_401]) {
      // Already forced once this process; do not loop.
      const terminal = new Error('ChatGPT returned 401 again after a forced capture reload.')
      terminal.status = 401
      terminal.statusCode = 401
      terminal.code = 'chatgpt_401_after_recovery'
      throw terminal
    }
    api[ONE_SHOT_401] = true
    return fn()
  }
}

/**
 * Refresh sentinel + conduit before a turn. Any failure is logged, not
 * thrown: the request path may still succeed with the tokens the process
 * already holds, and a hard failure here would mask the real upstream error.
 */
async function refreshSentinelSafe(api) {
  try {
    if (typeof api._refreshSentinel === 'function') {
      await api._refreshSentinel()
      return { ok: true }
    }
    return { ok: false, reason: 'no_refresh_method' }
  } catch (error) {
    console.warn('Sentinel refresh failed: ' + (error.message || error))
    return { ok: false, reason: error && error.message ? error.message : String(error) }
  }
}

/**
 * Re-exported so the router can construct a wrapper without reaching into
 * the API internals more than once.
 */
function wrap(api) {
  return {
    api,
    withAuthRecovery: (fn) => withAuthRecovery(api, fn),
    refreshSentinelSafe: () => refreshSentinelSafe(api),
    forceReloadCapture: () => forceReloadCapture(api),
  }
}

module.exports = {
  ONE_SHOT_401,
  forceReloadCapture,
  isUnauthorized,
  refreshSentinelSafe,
  withAuthRecovery,
  wrap,
}
