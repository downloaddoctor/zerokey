const https = require('https')
const { CookieJar } = require('../../utils/cookie-jar')

// Keep-alive agent — reuses TCP connections, avoids TLS handshake per request
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 60000,
})
const { DeepSeekPOW } = require('./pow')

class DeepSeekAPI {
  static BASE_URL_OBJ = new URL('https://chat.deepseek.com/api/v0')

  constructor() {
    this.powSolver = null
    this._cookies = new CookieJar()
  }

  async initialize(headers = {}) {
    this.powSolver = new DeepSeekPOW()
    await this.powSolver.initialize()

    // Seed cookie jar from initial headers if present
    const initialCookie = headers.cookie || headers.Cookie || ''
    if (initialCookie) {
      const count = this._cookies.seedFromHeader(initialCookie)
      if (count > 0) {
        console.log(`[DeepSeek] Seeded cookie jar with ${count} initial cookies`)
      }
    }
  }

  async createChatSession(headers) {
    try {
      const response = await this._makeRequest('POST', '/chat_session/create', headers, {
        character_id: null,
      })

      const id = response.data.biz_data.id || response.data.biz_data.chat_session.id

      console.log('[DeepSeekAPI] NEW SESSION:', id)
      return id
    } catch (error) {
      throw new Error('Failed to create chat session: ' + error.message)
    }
  }

  /**
   * Send a chat completion request. Returns the raw HTTPS response stream.
   */
  async chatCompletion(
    headers,
    chatSessionId,
    prompt,
    parentMessageId = null,
    thinkingEnabled = false,
    searchEnabled = false,
    modelType = null,
  ) {
    const challenge = await this._getPowChallenge(headers)
    const powResponse = await this.powSolver.solveChallenge(challenge)

    const jsonData = {
      chat_session_id: chatSessionId,
      parent_message_id: parentMessageId,
      model_type: modelType,
      prompt,
      ref_file_ids: [],
      thinking_enabled: thinkingEnabled,
      search_enabled: searchEnabled,
    }

    console.log('[PROMPT] REQ', {
      chatSessionId,
      parentMessageId,
      prompt,
      promptLength: prompt.length,
    })

    const postData = JSON.stringify(jsonData)

    // Inject cookies from jar
    const requestHeaders = { ...headers }
    const cookieStr = this._cookies.toString()
    if (cookieStr) {
      requestHeaders.cookie = cookieStr
    }

    const options = {
      hostname: DeepSeekAPI.BASE_URL_OBJ.hostname,
      port: 443,
      path: DeepSeekAPI.BASE_URL_OBJ.pathname + '/chat/completion',
      method: 'POST',
      headers: {
        ...requestHeaders,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'x-ds-pow-response': powResponse,
      },
      agent: keepAliveAgent,
    }

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        // Capture cookies from streaming response too
        this._cookies.captureFromRawHeaders(res.headers, ' DeepSeek')

        if (res.statusCode !== 200) {
          let errorBody = ''
          res.on('data', (chunk) => (errorBody += chunk))
          res.on('end', () => {
            const err = new Error(`DeepSeek HTTP ${res.statusCode}: ${errorBody.slice(0, 300)}`)
            err.code = res.statusCode
            reject(err)
          })
          return
        }
        resolve(res)
      })
      req.on('error', reject)
      req.write(postData)
      req.end()
    })
  }

  // ─── Internal ───
  async _getPowChallenge(headers) {
    try {
      const response = await this._makeRequest('POST', '/chat/create_pow_challenge', headers, {
        target_path: '/api/v0/chat/completion',
      })
      return response.data.biz_data.challenge
    } catch (error) {
      throw new Error('Failed to get POW challenge: ' + error.message)
    }
  }

  _makeRequest(method, endpoint, headers, jsonData) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(jsonData)

      // Inject cookie jar into request headers
      const requestHeaders = { ...headers }
      const cookieStr = this._cookies.toString()
      if (cookieStr) {
        requestHeaders.cookie = cookieStr
      }

      const options = {
        hostname: DeepSeekAPI.BASE_URL_OBJ.hostname,
        port: 443,
        path: DeepSeekAPI.BASE_URL_OBJ.pathname + endpoint,
        method,
        headers: {
          ...requestHeaders,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        agent: keepAliveAgent,
        rejectUnauthorized: false,
        timeout: 30000,
      }

      const req = https.request(options, (res) => {
        // Capture cookies from response
        this._cookies.captureFromRawHeaders(res.headers, ' DeepSeek')

        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString()
          try {
            if (res.statusCode >= 400) {
              return reject(new Error(body, res.statusCode))
            }
            resolve(JSON.parse(body))
          } catch (e) {
            reject(new Error('Invalid JSON response'))
          }
        })
      })

      req.on('error', (e) => reject(new Error(e.message)))
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Request timeout'))
      })
      req.write(postData)
      req.end()
    })
  }
}

module.exports = { DeepSeekAPI }
