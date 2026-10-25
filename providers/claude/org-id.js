'use strict'

/**
 * Shared organization-ID extraction for both Claude transports.
 *
 * Priority order (matches every capture shape observed):
 *   1. legacy URL path /organizations/<uuid> (REST SSE captures)
 *   2. x-organization-uuid header (RPC/Connect captures)
 *   3. lastActiveOrg cookie (older sessions without either)
 */

const URL_PATH_RE = /\/organizations\/([a-f0-9-]{36})/i

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return headers[key]
  }
  return null
}

function resolveOrgId(parsedFetch, headers) {
  const url = String(
    (parsedFetch && parsedFetch.url) ||
      (parsedFetch && parsedFetch.request && parsedFetch.request.url) ||
      '',
  )
  const fromUrl = url.match(URL_PATH_RE)
  if (fromUrl) return fromUrl[1]

  const fromHeader = headerValue(headers, 'x-organization-uuid')
  if (fromHeader) return fromHeader

  const cookie = String(
    headerValue(headers, 'cookie') ||
      (parsedFetch && parsedFetch.headers && parsedFetch.headers.Cookie) ||
      '',
  )
  const fromCookie = cookie.match(/(?:^|;\s*)lastActiveOrg=([a-f0-9-]{36})/i)
  if (fromCookie) return fromCookie[1]

  return null
}

module.exports = { resolveOrgId, URL_PATH_RE }
