'use strict'

/**
 * Bounded, redacted diagnostics.
 *
 * Every string is passed through `log.redact()` before it leaves this module.
 * Every array and object is capped so a runaway state cannot turn the
 * diagnostics response itself into a memory problem. Deep nesting is cut off.
 * Object keys whose names are secret-shaped (e.g. `access`) have their values
 * replaced with `<redacted>` regardless of content, since the value on its own
 * has no surrounding JSON for the string-level regexes to match against.
 */

const log = require('./log')

const MAX_STRING_CHARS = 2000
const MAX_ARRAY_ITEMS = 100
const MAX_OBJECT_KEYS = 100
const MAX_DEPTH = 8

function sanitize(value, depth = 0) {
  if (depth > MAX_DEPTH) return '<truncated>'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    const redacted = log.redact(value)
    return redacted.length > MAX_STRING_CHARS
      ? redacted.slice(0, MAX_STRING_CHARS) + '…<truncated>'
      : redacted
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1))
    if (value.length > MAX_ARRAY_ITEMS) out.push('<more entries truncated>')
    return out
  }
  if (typeof value === 'object') {
    const out = {}
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS)
    for (const [key, item] of entries) {
      if (log.isSecretKey(key) && item !== null && item !== undefined) {
        out[key] = '<redacted>'
        continue
      }
      out[key] = sanitize(item, depth + 1)
    }
    if (Object.keys(value).length > MAX_OBJECT_KEYS) out._truncated = true
    return out
  }
  return sanitize(String(value), depth + 1)
}

function versionPayload(startedAt) {
  let pkg = {}
  try {
    pkg = require('../package.json')
  } catch (caughtErr) {
    console.error('require() failed:', caughtErr)
  }
  return {
    name: pkg.name || 'zerokey-proxy',
    version: pkg.version || 'unknown',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  }
}

function providerStatusPayload(provider, preSelected) {
  let readiness = null
  try {
    readiness =
      provider && typeof provider.ready === 'function'
        ? provider.ready()
        : { ok: true, detail: 'provider does not expose ready()' }
  } catch (error) {
    console.error('provider.ready() threw:', error)
    readiness = {
      ok: false,
      detail: error && error.message ? error.message : String(error),
    }
  }

  return sanitize({
    provider: preSelected?.provider || null,
    session: preSelected?.sessionName || null,
    model: preSelected?.session?.model || null,
    toolCalling: preSelected?.session?.toolCalling ?? null,
    ready: Boolean(readiness && readiness.ok),
    detail: readiness && readiness.detail ? readiness.detail : null,
  })
}

function diagnosePayload(options) {
  const store = options.db || null
  const counts = {}
  if (store) {
    try {
      counts.sessions = store.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
      counts.schemaVersion =
        store.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? null
    } catch (error) {
      console.error('diagnostics: reading session counts failed:', error)
      counts.error = error.message
    }
  }

  return sanitize({
    status: 'ok',
    listener: options.host + ':' + options.port,
    version: versionPayload(options.startedAt),
    provider: options.providerStatus || null,
    state: counts,
    queue: options.queue || null,
    memory: process.memoryUsage(),
  })
}

module.exports = {
  MAX_ARRAY_ITEMS,
  MAX_DEPTH,
  MAX_OBJECT_KEYS,
  MAX_STRING_CHARS,
  diagnosePayload,
  providerStatusPayload,
  sanitize,
  versionPayload,
}
