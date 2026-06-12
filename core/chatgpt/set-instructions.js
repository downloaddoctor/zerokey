const instructions = require('../../lib/engine/instructions')

async function setChatGPTInstructions(chatgptApi, userData) {
  if (!userData) return false

  const currentHash = instructions.getHash()
  if (userData.instructionsHash === currentHash) return false

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
