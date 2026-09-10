/**
 * Maps raw provider errors to user-friendly messages with recovery actions.
 */
function classifyError(error, provider) {
  const msg = (error?.message || String(error) || '').toLowerCase()
  const statusCode = error?.code || error?.statusCode || error?.status || 0

  // ── Device/IP flagged (Cloudflare bot-behavior detection) ──
  // Distinct from a stale session: re-capturing a fetch() from the same
  // flagged device/IP will not fix this — it needs time (and/or a different
  // network) to clear, not new cookies.
  if (statusCode === 403 && msg.includes('unusual activity')) {
    const cooldownSec = error?.cooldownMs ? Math.ceil(error.cooldownMs / 1000) : null
    return {
      category: 'device_flagged',
      message: `${provider} flagged this device/IP for unusual activity (Cloudflare bot detection).`,
      action: cooldownSec
        ? `Pausing this session for ~${cooldownSec}s. Avoid retrying immediately — repeated attempts while flagged can prolong the block. If it persists, try a different network/IP.`
        : 'Wait before retrying — repeated attempts while flagged can prolong the block. If it persists, try a different network/IP.',
      status: 403,
    }
  }

  // ── Provider-stream inline error frame ─────────────────
  // Emitted by stream handlers when the provider pushes an `error` payload
  // mid-stream (bad model, quota, invalid param, etc.). Preserve the actual
  // provider message rather than collapsing to the generic fallback.
  if (msg.includes('stream error:')) {
    const detail = (error?.message || '').split('stream error:')[1]?.trim()
    return {
      category: 'provider_error',
      message: `${provider} returned a stream error: ${detail || 'unknown error'}`,
      action:
        'Check the model id / request parameters, or re-capture a fresh fetch() if it persists.',
      status: statusCode >= 400 ? statusCode : 502,
    }
  }

  // ── Session expired / auth failures ────────────────────
  if (statusCode === 401 || statusCode === 403) {
    return {
      category: 'session_expired',
      message: `Your ${provider} browser session has expired or is invalid.`,
      action: `Re-capture a fresh fetch() from ${getProviderURL(provider)} DevTools and restart the server.`,
      status: 401,
    }
  }

  // ── Rate limiting ──────────────────────────────────────
  if (statusCode === 429) {
    const cooldownSec = error?.cooldownMs ? Math.ceil(error.cooldownMs / 1000) : null
    const waitHint = cooldownSec
      ? ` Retry in ~${cooldownSec}s.`
      : ' Wait a few minutes and try again.'
    return {
      category: 'rate_limited',
      message: `You've hit ${provider}'s hourly message limit.`,
      action: `${waitHint} Or switch to a different user account in the startup wizard.`,
      status: 429,
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
    qwen: 'chat.qwen.ai',
  }
  return urls[provider?.toLowerCase()] || provider || 'the provider'
}

/**
 * Build a full OpenAI-compatible error response with user-friendly details.
 *
 * @param {Error|object} error - Raw error from provider
 * @param {string} provider - 'deepseek' | 'claude' | 'chatgpt'
 * @param {string} type - OpenAI error type
 * @param {string} code - OpenAI error code
 */
function toOpenAIError(error, provider, type, code) {
  // Direct-message overload: toOpenAIError(status, message, type, code)
  // Used by route handlers for simple validation errors, bypassing classifyError.
  if (typeof error === 'number' && typeof provider === 'string') {
    return {
      error: {
        message: provider,
        type: type || 'invalid_request_error',
        code: code || 'invalid_request',
        action: null,
        category: type || 'invalid_request_error',
        status: error,
      },
    }
  }

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
