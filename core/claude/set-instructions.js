const instructions = require('../../lib/engine/instructions')

async function setClaudeInstructions(claudeApi, userData, dynamicGrammar, toolCalling = true) {
  if (!userData) return false

  const currentHash = instructions.getHash()
  if (userData.instructionsHash === currentHash) return false

  const content = toolCalling ? instructions.getFull() + (dynamicGrammar || '') : ''
  const payload = JSON.stringify({ conversation_preferences: content })
  const headers = claudeApi._buildHeaders(
    { accept: '*/*', origin: 'https://claude.ai' },
    '/api/account_profile',
  )

  try {
    const res = await claudeApi._fetch('https://claude.ai/api/account_profile', {
      method: 'PUT',
      headers,
      body: payload,
    })

    const data = await res.text()

    if (res.ok) {
      userData.instructionsHash = currentHash
      userData.instructionsAppliedAt = new Date().toISOString()
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
