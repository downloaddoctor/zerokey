const instructions = require('../../lib/engine/instructions')

/**
 * Set ChatGPT custom instructions via the user_system_messages API.
 * Only fires when instructions.md hash differs from last applied state.
 * Uses chatgptApi._buildHeaders() to ensure all sentinel/Cloudflare headers
 * are present — same as real chat requests.
 */
async function setChatGPTInstructions(chatgptApi, userData, saveSession) {
  if (!userData) return false

  const currentHash = instructions.getHash()

  // Skip if already applied with same hash
  if (userData.instructionsHash === currentHash) {
    return false
  }

  const base = instructions.getBase()

  const payload = JSON.stringify({
    about_user_message: '',
    about_model_message: base,
    name_user_message: '',
    role_user_message: '',
    traits_model_message: base,
  })

  const headers = chatgptApi._buildHeaders({ accept: '*/*' }, '/backend-api/user_system_messages')

  try {
    const res = await fetch('https://chatgpt.com/backend-api/user_system_messages', {
      method: 'PATCH',
      headers,
      body: payload,
      redirect: 'follow',
    })

    const data = await res.text()

    if (res.ok) {
      userData.instructionsHash = currentHash
      userData.instructionsAppliedAt = new Date().toISOString()
      saveSession()
      console.log('[ChatGPT] Custom instructions set successfully')
      return true
    } else {
      console.warn(`[ChatGPT] Failed to set instructions: ${res.status} ${data}`)
      return false
    }
  } catch (err) {
    console.warn('[ChatGPT] Instructions API error:', err.message)
    return false
  }
}

module.exports = { setChatGPTInstructions }
