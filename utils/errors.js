/**
 * OpenAI-compatible error factory with user-friendly messages.
 *
 * Error categories:
 *   - overloaded         → provider is overloaded, try later or switch
 *   - session_expired    → re-capture fetch from browser
 *   - rate_limited       → wait or switch sessions
 *   - cloudflare_block   → browser fingerprint rejected
 *   - auth_failed        → credentials invalid / session revoked
 *   - network            → connection failed / timeout
 *   - invalid_request    → bad input from client
 *   - provider_error     → upstream returned an error
 *   - internal           → unexpected server error
 */

/**
 * Maps raw provider errors to user-friendly messages with recovery actions.
 */
function classifyError(error, provider) {
  const msg = (error?.message || String(error) || '').toLowerCase()
  const statusCode = error?.code || error?.statusCode || error?.status || 0

  // ── Provider overloaded ───────────────────────────────
  if (
    msg.includes('overloaded') ||
    msg.includes('overloaded_error') ||
    msg.includes('over capacity')
  ) {
    return {
      category: 'overloaded',
      message: `${provider} is currently overloaded.`,
      action:
        'Try again in a few minutes, or switch to a different provider (restart the server to change).',
      status: 529,
    }
  }

  // ── Session expired / auth failures ────────────────────
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('auth') ||
    msg.includes('login') ||
    msg.includes('session') ||
    msg.includes('expired') ||
    msg.includes('invalid token') ||
    msg.includes('proof token') ||
    msg.includes('sentinel')
  ) {
    return {
      category: 'session_expired',
      message: `Your ${provider} browser session has expired or is invalid.`,
      action: `Re-capture a fresh fetch() from ${getProviderURL(provider)} DevTools and restart the server.`,
      status: 401,
    }
  }

  // ── Rate limiting ──────────────────────────────────────
  if (
    statusCode === 429 ||
    msg.includes('rate') ||
    msg.includes('too many') ||
    msg.includes('limit')
  ) {
    return {
      category: 'rate_limited',
      message: `You've hit ${provider}'s rate limit.`,
      action:
        'Wait a few minutes and try again, or switch to a different session in the startup wizard.',
      status: 429,
    }
  }

  // ── Cloudflare / bot detection ─────────────────────────
  if (
    msg.includes('cloudflare') ||
    msg.includes('cf-') ||
    msg.includes('challenge') ||
    msg.includes('captcha') ||
    msg.includes('1020') ||
    msg.includes('just a moment') ||
    msg.includes('are you human') ||
    msg.includes('browser check')
  ) {
    return {
      category: 'cloudflare_block',
      message: `${provider} is showing a Cloudflare challenge — your browser fingerprint was rejected.`,
      action:
        'Re-capture a fresh fetch() from your browser and restart. Make sure you are logged in and can chat normally in the browser first.',
      status: 403,
    }
  }

  // ── Network errors ─────────────────────────────────────
  if (
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('econnreset') ||
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('network')
  ) {
    return {
      category: 'network',
      message: `Cannot reach ${provider}. Network error.`,
      action:
        'Check your internet connection. If you are behind a VPN or proxy, try disconnecting it.',
      status: 502,
    }
  }

  // ── Invalid input ──────────────────────────────────────
  if (msg.includes('invalid json') || msg.includes('parse')) {
    return {
      category: 'invalid_request',
      message: `${provider} returned an unexpected response (possibly an error page).`,
      action:
        'This usually means the session is invalid. Re-capture a fresh fetch() and try again.',
      status: 502,
    }
  }

  // ── Generic provider error ─────────────────────────────
  if (statusCode >= 400) {
    return {
      category: 'provider_error',
      message: `${provider} returned an error (HTTP ${statusCode}).`,
      action: 'If this persists, re-capture a fresh fetch() from your browser.',
      status: 502,
    }
  }

  // ── Unknown / fallback ─────────────────────────────────
  return {
    category: 'internal',
    message: `An unexpected error occurred with ${provider}.`,
    action:
      'Try restarting the server. If the issue persists, re-capture a fresh fetch() from your browser.',
    status: 500,
  }
}

function getProviderURL(provider) {
  const urls = {
    deepseek: 'chat.deepseek.com',
    chatgpt: 'chatgpt.com',
    claude: 'claude.ai',
  }
  return urls[provider?.toLowerCase()] || provider || 'the provider'
}

/**
 * Build a full OpenAI-compatible error response with user-friendly details.
 *
 * @param {Error|object} error - Raw error from provider
 * @param {string} provider - 'deepseek' | 'chatgpt' | 'claude'
 * @param {string} type - OpenAI error type
 * @param {string} code - OpenAI error code
 */
function toOpenAIError(error, provider, type, code) {
  const classified = classifyError(error, provider)

  return {
    error: {
      message: classified.message,
      type: type || classified.category || 'api_error',
      code: code || classified.category || 'internal_error',
      action: classified.action,
      category: classified.category,
      status: classified.status || 500,
    },
  }
}

module.exports = { toOpenAIError, classifyError }
