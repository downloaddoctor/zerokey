'use strict'

/**
 * Per-session transport choice shared by every provider router.
 * session.transport (set in the wizard) overrides the provider's env default;
 * an unknown or stale value falls back to the default, then to allowed[0].
 */
function resolveSessionTransport(session, envDefault, allowed) {
  const pick = String((session && session.transport) || envDefault || '').toLowerCase()
  if (allowed.includes(pick)) return pick
  if (allowed.includes(envDefault)) return envDefault
  return allowed[0]
}

module.exports = { resolveSessionTransport }
