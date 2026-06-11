const instructions = require('../../lib/engine/instructions')

/**
 * Set Claude custom instructions via the account_profile API.
 * Only fires when instructions.md hash differs from last applied state.
 * Uses claudeApi._buildHeaders() to ensure all Cloudflare/Anthropic fingerprint
 * headers are present — same as real chat requests.
 */
async function setClaudeInstructions(claudeApi, userData, saveSession) {
  if (!userData) return false

  const currentHash = instructions.getHash()

  // Skip if already applied with same hash
  if (userData.instructionsHash === currentHash) {
    return false
  }

  const payload = JSON.stringify({ conversation_preferences: instructions.getFull() })

  const headers = claudeApi._buildHeaders({ accept: '*/*' }, '/api/account_profile')

  try {
    const res = await fetch('https://claude.ai/api/account_profile', {
      method: 'PUT',
      headers,
      body: payload,
      redirect: 'follow',
    })

    const data = await res.text()

    if (res.ok) {
      userData.instructionsHash = currentHash
      userData.instructionsAppliedAt = new Date().toISOString()
      saveSession()
      console.log('[Claude] Custom instructions set successfully')
      return true
    } else {
      console.warn(`[Claude] Failed to set instructions: ${res.status} ${data}`)
      return false
    }
  } catch (err) {
    console.warn('[Claude] Instructions API error:', err.message)
    return false
  }
}

module.exports = { setClaudeInstructions }
