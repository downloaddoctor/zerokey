const instructions = require('../../engine/instructions')

async function setQwenInstructions(qwenApi, userData, toolCalling = true) {
  if (!userData) return false

  const { content, hash } = instructions.getUnlimited()
  if (userData.instructionsHash === hash) return false

  const finalContent = toolCalling ? content : ''
  const payload = JSON.stringify({
    personalization: {
      name: '',
      description: '',
      instruction: finalContent,
    },
  })

  try {
    const res = await qwenApi._fetch(
      'https://chat.qwen.ai/api/v2/users/user/settings/update',
      {
        method: 'POST',
        headers: qwenApi._buildHeaders(),
        body: payload,
      },
      false,
    )

    const data = await res.text()

    if (res.ok) {
      userData.instructionsHash = hash
      userData.instructionsAppliedAt = new Date().toISOString()
      console.success('[Qwen] Custom instructions set successfully')
      return true
    }

    console.warn(`[Qwen] Failed to set instructions: ${res.status} ${data}`)
    return false
  } catch (err) {
    console.warn('[Qwen] Instructions API error:', err.message)
    return false
  }
}

module.exports = { setQwenInstructions }
