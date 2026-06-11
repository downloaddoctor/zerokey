const https = require('https')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

let _cachedHash = null

function getInstructionsHash() {
  if (_cachedHash) return _cachedHash
  const instructions = fs.readFileSync(
    path.join(__dirname, '..', '..', 'lib', 'engine', 'instructions.md'),
    'utf8',
  )
  _cachedHash = crypto.createHash('sha256').update(instructions).digest('hex')
  return _cachedHash
}

/**
 * Set Claude custom instructions via the account_profile API.
 * Only fires when instructions.md hash differs from last applied state.
 * Hash is cached at startup — instructions.md changes require a server restart.
 */
async function setClaudeInstructions(parsedFetch, userData, saveSession) {
  const currentHash = getInstructionsHash()

  // Skip if already applied with same hash
  if (userData.instructionsHash === currentHash) {
    return false
  }

  const { headers } = parsedFetch
  const bearer = headers.authorization || headers.Authorization || ''
  const cookies = headers.cookie || headers.Cookie || ''

  const instructions = fs.readFileSync(
    path.join(__dirname, '..', '..', 'lib', 'engine', 'instructions.md'),
    'utf8',
  )

  const payload = {
    conversation_preferences: instructions,
  }

  const postData = JSON.stringify(payload)

  const options = {
    hostname: 'claude.ai',
    path: '/api/account_profile',
    method: 'PUT',
    headers: {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      authorization: bearer,
      'content-type': 'application/json',
      cookie: cookies,
      Referer: 'https://claude.ai/new',
    },
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          userData.instructionsHash = currentHash
          userData.instructionsAppliedAt = new Date().toISOString()
          saveSession()
          console.log('[Claude] Custom instructions set successfully')
          resolve(true)
        } else {
          console.warn(`[Claude] Failed to set instructions: ${res.statusCode} ${data}`)
          resolve(false)
        }
      })
    })

    req.on('error', (err) => {
      console.warn('[Claude] Instructions API error:', err.message)
      resolve(false)
    })

    req.write(postData)
    req.end()
  })
}

module.exports = { setClaudeInstructions }
