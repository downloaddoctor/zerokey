const crypto = require('crypto')

/**
 * ChatGPT Sentinel POW Solver
 *
 * The sentinel proof token format (gAAAAAB prefix):
 *   gAAAAAB + base64(JSON array of 25 elements)
 *
 * Real config structure (decoded from browser tokens):
 *   [0]  number   - screen width × pixelRatio (e.g. 2400)
 *   [1]  string   - UTC timestamp (e.g. "Sat May 23 2026 04:47:19 GMT-0700...")
 *   [2]  number   - constant from browser (varies, e.g. 2248146944)
 *   [3]  number   - counter (the POW iteration that solved)
 *   [4]  string   - userAgent
 *   [5]  null     - always null
 *   [6]  string   - client version (e.g. "prod-8117aba90ffac2b43...")
 *   [7]  string   - locale (e.g. "en-US")
 *   [8]  string   - languages (e.g. "en-US,en")
 *   [9]  number   - constant (e.g. 10)
 *   [10] string   - feature detection string
 *   [11] string   - "location"
 *   [12] string   - "onseeking"
 *   [13] number   - scrollX position (float)
 *   [14] string   - random UUID
 *   [15] string   - empty string ""
 *   [16] number   - constant (e.g. 4)
 *   [17] number   - Date.now() timestamp (float)
 *   [18] number   - flag (0)
 *   [19] number   - flag (0)
 *   [20] number   - flag (0)
 *   [21] number   - flag (0)
 *   [22] number   - flag (1)
 *   [23] number   - flag (0)
 *   [24] number   - flag (0)
 *
 * POW challenge: { seed: "0.8995367315420799", difficulty: "07a120" }
 * Algorithm: SHA3-512(seed + base64(JSON.stringify(config))) → hex must start ≤ difficulty
 */
class ChatGPTProofOfWork {
  /**
   * Decode a proof token (gAAAAAB...) into its config array.
   * @param {string} token - The proof token from headers
   * @returns {object} The decoded config array
   */
  static decodeProofToken(token) {
    if (!token || !token.startsWith('gAAAAAB')) {
      throw new Error('Invalid proof token: must start with gAAAAAB')
    }
    const base64 = token.slice(7) // remove 'gAAAAAB'
    const json = Buffer.from(base64, 'base64').toString('utf8')
    const config = JSON.parse(json)
    if (!Array.isArray(config) || config.length < 18) {
      throw new Error(`Invalid proof token config: expected array of 25, got ${config.length}`)
    }
    return config
  }

  /**
   * Encode a config array back into a proof token.
   * @param {Array} config - The config array
   * @returns {string} gAAAAAB + base64(JSON)
   */
  static encodeProofToken(config) {
    const json = JSON.stringify(config)
    const base64 = Buffer.from(json).toString('base64')
    return 'gAAAAAB' + base64
  }

  /**
   * Solve a sentinel proof-of-work challenge.
   * Uses the real config from the user's existing proof token, only mutates:
   *   [1] timestamp, [3] counter, [17] timestamp
   *
   * @param {string} seed - The challenge seed
   * @param {string} difficulty - Hex prefix the hash must be ≤ (e.g. "07a120")
   * @param {Array} config - Real config array decoded from user's proof token
   * @returns {string} The solved proof token prefixed with 'gAAAAAB'
   * @throws {Error} If POW unsolvable after 100000 iterations
   */
  static solve(seed, difficulty, config) {
    if (!Array.isArray(config) || config.length < 18) {
      throw new Error('solve: config must be a valid proof token array (min 18 elements)')
    }

    const diffLen = difficulty.length / 2

    for (let i = 0; i < 100000; i++) {
      // Update mutable fields
      config[1] = ChatGPTProofOfWork._makeTimestamp()
      config[3] = i
      config[17] = Date.now()

      const json = JSON.stringify(config)
      const base = Buffer.from(json).toString('base64')
      const hashValue = crypto
        .createHash('sha3-512')
        .update(seed + base)
        .digest()

      if (hashValue.toString('hex').substring(0, diffLen) <= difficulty) {
        return 'gAAAAAB' + base
      }
    }

    throw new Error(`POW unsolvable: seed=${seed} difficulty=${difficulty} after 100000 iterations`)
  }

  /**
   * Generate the sentinel proof token sent as {p: ...} to the sentinel endpoint.
   * Uses real config from user's decoded proof token, only updating timestamp fields.
   *
   * @param {Array} config - Real config array decoded from user's proof token
   * @returns {string} gAAAAAC + base64(JSON)
   */
  static generateSentinelProof(config) {
    if (!Array.isArray(config) || config.length < 18) {
      throw new Error('generateSentinelProof: config must be a valid proof token array')
    }

    // Clone and update mutable fields for the sentinel request
    const proofConfig = [...config]
    proofConfig[1] = ChatGPTProofOfWork._makeTimestamp()
    proofConfig[3] = 0 // counter resets for sentinel proof
    proofConfig[17] = Date.now()

    const json = JSON.stringify(proofConfig)
    const base64 = Buffer.from(json).toString('base64')
    return 'gAAAAAC' + base64
  }

  /**
   * Generate a GMT-0700 (Pacific) timestamp matching ChatGPT's format.
   */
  static _makeTimestamp() {
    const now = new Date(Date.now() - 8 * 3600 * 1000)
    return now.toUTCString().replace('GMT', 'GMT-0700 (Pacific Daylight Time)')
  }
}

module.exports = { ChatGPTProofOfWork }
