'use strict'

const instructions = require('../../engine/instructions')

/**
 * Set ChatGPT custom instructions via PATCH /backend-api/user_system_messages.
 * Uses engine/extra/instructions-1500.md (fits ChatGPT's 1500-char field).
 * Fires only when the fragment hash differs from the last applied hash.
 */
async function setChatGPTInstructions(chatgptApi, userData, toolCalling = true) {
  if (!userData) return false

  const { content, hash } = instructions.getExtra('instructions-1500')
  if (userData.instructionsHash === hash) return false

  const finalContent = toolCalling ? content : ''
  const payload = JSON.stringify({
    about_user_message: '',
    about_model_message: finalContent,
    name_user_message: '',
    role_user_message: '',
    traits_model_message: finalContent,
  })
  const headers = chatgptApi._buildHeaders(
    { accept: '*/*', origin: 'https://chatgpt.com', referer: 'https://chatgpt.com/' },
    '/backend-api/user_system_messages',
  )

  try {
    const res = await chatgptApi._fetch('https://chatgpt.com/backend-api/user_system_messages', {
      method: 'PATCH',
      headers,
      body: payload,
    })

    const data = await res.text()

    if (res.ok) {
      userData.instructionsHash = hash
      userData.instructionsAppliedAt = new Date().toISOString()
      console.success('[ChatGPT] Custom instructions set successfully')
      return true
    }
    console.warn(`[ChatGPT] Failed to set instructions: ${res.status} ${data}`)
    return false
  } catch (err) {
    console.error('chatgptApi._fetch() failed:', err)
    console.warn('[ChatGPT] Instructions API error:', err.message)
    return false
  }
}

module.exports = { setChatGPTInstructions }
