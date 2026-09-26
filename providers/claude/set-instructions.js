const instructions = require('../../engine/instructions')

async function setClaudeInstructions(claudeApi, userData, toolCalling = true) {
  if (!userData) return false

  const { content, hash } = instructions.getUnlimited()
  if (userData.instructionsHash === hash) return false

  const finalContent = toolCalling ? content : ''
  const payload = JSON.stringify({ conversation_preferences: finalContent })
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
      userData.instructionsHash = hash
      userData.instructionsAppliedAt = new Date().toISOString()
      console.success('[Claude] Custom instructions set successfully')
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
