const instructions = require('../../engine/instructions')

/**
 * Write ZeroKey's system instructions into the Qwen account's
 * personalization settings so they persist server-side across chats.
 *
 * Endpoint: POST /api/v2/users/user/settings/update
 * Body:     { personalization: { name, description, instruction } }
 *
 * Mirrors setClaudeInstructions — hashes instructions to skip redundant
 * writes, returns true when the profile was updated.
 */
async function setQwenInstructions(qwenApi, userData, toolCalling = true) {
  if (!userData) return false

  const { content, hash } = instructions.getFull()
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
