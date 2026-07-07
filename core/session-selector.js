const fs = require('fs')
const path = require('path')
const inquirer = require('inquirer')
const { ClaudeAPI } = require('./claude/api')
const { DeepSeekAPI } = require('./deepseek/api')
const { ChatGPTAPI } = require('./chatgpt/api')

class SessionSelector {
  constructor() {
    this._dataDir = path.join(__dirname, '..', 'temp')
    this._usersFile = path.join(this._dataDir, 'users.json')
    this.TIMEOUT_MS = 0
    if (!fs.existsSync(this._dataDir)) {
      fs.mkdirSync(this._dataDir, { recursive: true })
    }
  }

  async select() {
    this.provider = await this._stepProviderSelection()
    if (!this.provider) return null

    this.user = await this._stepUserLogin()
    if (!this.user) return null

    if (!this.user.sessions) this.user.sessions = []

    if (this.provider === 'claude') {
      const allProviders = this._loadAll()
      const providerUsers = allProviders[this.provider] || {}

      // Auto-clear expired waitUntil for all users
      for (const u of Object.values(providerUsers)) {
        if (u.waitUntil && u.waitUntil <= Date.now()) {
          delete u.waitUntil
          delete u.waitReason
        }
      }

      const waitUntil = this.user.waitUntil || null
      if (waitUntil && waitUntil > Date.now()) {
        const mins = Math.ceil((waitUntil - Date.now()) / 60000)
        const resetsAt = new Date(waitUntil).toLocaleTimeString()
        console.warn(
          `\n⚠  User "${this.user.username}" is at limit. Resets at ${resetsAt} (~${mins} min).`,
        )

        // Check if any other user is available
        const availableUsers = Object.values(providerUsers).filter(
          (u) => u.username !== this.user.username && (!u.waitUntil || u.waitUntil <= Date.now()),
        )

        if (availableUsers.length > 0) {
          console.log('  Switching to another user...\n')
          this.user = await this._stepUserLogin()
          if (!this.user) return null
        } else {
          // All users at limit — find soonest reset
          const soonest = Object.values(providerUsers)
            .map((u) => ({ username: u.username, ts: u.waitUntil }))
            .filter((u) => u.ts)
            .sort((a, b) => a.ts - b.ts)[0]
          const minsLeft = Math.ceil((soonest.ts - Date.now()) / 60000)
          const resetsAtSoonest = new Date(soonest.ts).toLocaleTimeString()
          console.error(
            `\n🚫 All Claude users are at their usage limit.\n` +
              `   Soonest reset: "${soonest.username}" at ${resetsAtSoonest} (~${minsLeft} min).\n` +
              `   Please select a different provider.\n`,
          )

          return this.select()
        }
      }
    }

    this.session = await this._stepSessionSelection()
    if (!this.session) return null

    // Write initial selection to disk immediately (only time we write eagerly)
    this._saveUser(this.provider, this.user.username, this.user)

    return {
      user: this.user.username,
      userData: this.user,
      provider: this.provider,
      parsedFetch: this.user.parsedFetch || null,
      session: this.session,
      sessionName: this.session.name,
    }
  }

  /**
   * Flush current in-memory user state to disk.
   * Called by server.js on shutdown and before auto-switch.
   */
  flush() {
    if (this.provider && this.user) {
      this._saveUser(this.provider, this.user.username, this.user)
    }
  }

  /**
   * Non-interactively switch to the next available Claude user.
   * Finds the first user without an active waitUntil, creates a fresh session,
   * updates internal state, and returns a new selected object.
   * @param {string} [pendingSummary] - summary text to inject into the new session
   * Returns null if no available user found.
   */
  switchToNextAvailable(pendingSummary) {
    if (this.provider !== 'claude') return null

    const all = this._loadAll()
    const providerUsers = all['claude'] || {}
    const now = Date.now()

    const nextUser = Object.values(providerUsers).find((u) => {
      if (u.username === this.user.username) return false
      const wu = u.waitUntil
      if (!wu) return true
      const ts = typeof wu === 'number' ? wu : new Date(wu).getTime()
      return ts <= now
    })

    if (!nextUser) return null

    console.log(`[SessionSelector] 🔄 Auto-switching to user: ${nextUser.username}`)

    const newSession = {
      name: new Date().toISOString().slice(0, 19).replace('T', ' '),
      chatSessionId: null,
      parentMessageId: null,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      pendingSummary: pendingSummary || undefined,
      disableTools: this.session?.disableTools || false,
    }

    if (!nextUser.sessions) nextUser.sessions = []
    nextUser.sessions.push(newSession)

    // Update internal state
    this.user = nextUser
    this.session = newSession

    return {
      user: nextUser.username,
      userData: nextUser,
      provider: 'claude',
      parsedFetch: nextUser.parsedFetch || null,
      session: newSession,
      sessionName: newSession.name,
    }
  }

  async _stepProviderSelection() {
    const choices = [
      { name: '  DeepSeek', value: 'deepseek' },
      { name: '  Claude', value: 'claude' },
      { name: '  ChatGPT (not recommended)', value: 'chatgpt' },
    ]

    const { provider } = await inquirer.prompt([
      {
        type: 'list',
        name: 'provider',
        message: 'Select AI Provider:',
        choices,
        pageSize: 10,
      },
    ])
    return provider
  }

  async _stepUserLogin() {
    const allProviders = this._loadAll()
    const providerUsers = allProviders[this.provider] || {}
    const savedUsers = Object.keys(providerUsers)

    if (savedUsers.length > 0) {
      const choices = [
        ...savedUsers.map((username) => ({ name: `  ${username}`, value: username })),
        { name: '＋ Create new user...', value: '__new__' },
      ]

      const { username } = await inquirer.prompt([
        {
          type: 'list',
          name: 'username',
          message: `Select User (${this.provider}):`,
          choices,
          pageSize: 10,
        },
      ])

      if (username === '__new__') return this._promptNewUser()
      return providerUsers[username]
    }

    return this._promptNewUser()
  }

  async _promptNewUser() {
    console.log('\n=== Create New User ===\n')
    const { username } = await inquirer.prompt([
      {
        type: 'input',
        name: 'username',
        message: 'Enter Username:',
        validate: (v) => v.trim().length > 0 || 'Username is required',
      },
    ])

    if (!username) return null

    console.log(
      '\nPaste the full fetch() call from browser DevTools:\n' +
        '  DevTools → Network → Find a "conversation" request → Right-click → Copy → Copy as fetch\n' +
        '  (This captures ALL headers + body with real browser fingerprint)\n',
    )
    const fetchStr = await this._stepFetchInput()
    if (!fetchStr) return null

    const parsedFetch = this._parseFetchDirect(fetchStr)

    const user = { username, parsedFetch, sessions: [] }
    this._saveUser(this.provider, username, user)
    return user
  }

  async _stepSessionSelection() {
    const sessions = this.user.sessions || []

    const choices = sessions.map((s, i) => ({
      name: `${s.name}${s.model ? `  │  ${s.model}` : ''}  │  last: ${this._formatTime(s.lastUsed)}${s.disableTools ? '  [no tools]' : ''}`,
      value: i,
    }))

    choices.push({ name: '＋ Create new session...', value: -1 })
    if (sessions.length > 0) {
      choices.push({ name: '🗑 Delete all sessions...', value: -2 })
    }

    const result = await this._prompt(choices)

    if (result === null) return null
    if (result === -1) return this._createNewSession()
    if (result === -2) return this._deleteAllSessions()

    return this.user.sessions[result]
  }

  async _createNewSession() {
    const name = await this._promptSessionName()
    if (!name) return null

    const questions = [
      {
        type: 'confirm',
        name: 'disableTools',
        message: 'Disable tools (raw chat mode)?',
        default: false,
      },
    ]

    if (this.provider === 'claude') {
      questions.push({
        type: 'list',
        name: 'model',
        message: 'Claude model:',
        default: 'claude-sonnet-4-6',
        choices: [
          {
            name: 'SONNET 4.6 (recommended for tools)',
            value: 'claude-sonnet-4-6',
          },
          {
            name: 'SONNET 5',
            value: 'claude-sonnet-5',
          },
          {
            name: 'HAIKU 4.5',
            value: 'claude-haiku-4-5-20251001',
          },
        ],
      })
    }

    if (this.provider === 'chatgpt') {
      questions.push({
        type: 'list',
        name: 'model',
        message: 'ChatGPT model:',
        default: 'auto',
        choices: [{ name: 'auto (recommended)', value: 'auto' }],
      })
    }

    if (this.provider === 'deepseek') {
      questions.push({
        type: 'list',
        name: 'model',
        message: 'DeepSeek model:',
        default: 'expert',
        choices: [
          { name: 'V4 - Expert (recommended)', value: 'expert' },
          { name: 'V4 - Default', value: 'default' },
          { name: 'V4 - Vision', value: 'vision' },
        ],
      })
    }

    const { disableTools, model } = await inquirer.prompt(questions)

    const newSession = {
      name,
      chatSessionId: null,
      parentMessageId: null,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      disableTools: disableTools || false,
      model:
        model ||
        (this.provider === 'claude'
          ? 'claude-sonnet-4-6'
          : this.provider === 'chatgpt'
            ? 'auto'
            : this.provider === 'deepseek'
              ? 'expert'
              : undefined),
    }

    this.user.sessions.push(newSession)
    return newSession
  }

  async _deleteAllSessions() {
    const count = this.user.sessions.length
    const confirmed = await this._confirmDeleteAll(count)
    if (!confirmed) return this._stepSessionSelection()

    // Delete server-side sessions (one per session) — unified for all providers
    await this._deleteProviderSessions()

    this.user.sessions = []
    return this._createNewSession()
  }

  async _deleteProviderSessions() {
    const PROVIDERS = {
      deepseek: {
        label: 'DeepSeek',
        factory: () => new DeepSeekAPI(),
        init: (api) => api.initialize(this.user.parsedFetch?.headers || {}),
      },
      claude: {
        label: 'Claude',
        factory: () => new ClaudeAPI(),
        init: (api) => api.initializeFromJSON(this.user.parsedFetch || {}),
      },
      chatgpt: {
        label: 'ChatGPT',
        factory: () => new ChatGPTAPI(),
        init: (api) => api.initializeFromJSON(this.user.parsedFetch || {}),
      },
    }

    const cfg = PROVIDERS[this.provider]
    if (!cfg) return

    const toDelete = this.user.sessions.filter((s) => s.chatSessionId)
    if (toDelete.length === 0) return

    const api = cfg.factory()
    await cfg.init(api)

    console.log(`\n[${cfg.label}] Deleting ${toDelete.length} session(s)...`)
    let deleted = 0
    for (const session of toDelete) {
      try {
        await api.deleteSession(session.chatSessionId)
        deleted++
        console.log(`  [${deleted}/${toDelete.length}] Deleted ${session.chatSessionId}`)
      } catch (e) {
        console.warn(
          `  [${deleted + 1}/${toDelete.length}] Failed ${session.chatSessionId}: ${e.message}`,
        )
      }
    }
    console.log(`[${cfg.label}] Sessions deleted: ${deleted}/${toDelete.length}\n`)
  }

  _parseFetchDirect(fetchStr) {
    const urlMatch = fetchStr.match(/fetch\((['"`])([^'"` ]+)\1\s*,/)
    if (!urlMatch) throw new Error('Could not parse fetch URL')

    const afterUrl = fetchStr.slice(urlMatch[0].length)
    const optStart = afterUrl.indexOf('{')
    if (optStart === -1) throw new Error('Could not parse options')

    let depth = 0,
      inStr = false,
      sc = '',
      js = -1,
      je = -1
    for (let i = optStart; i < afterUrl.length; i++) {
      const c = afterUrl[i]
      if (inStr) {
        if (c === '\\') {
          i++
          continue
        }
        if (c === sc) inStr = false
        continue
      }
      if (c === '"' || c === "'") {
        inStr = true
        sc = c
        continue
      }
      if (c === '{') {
        if (depth === 0) js = i
        depth++
      } else if (c === '}') {
        depth--
        if (depth === 0) {
          je = i + 1
          break
        }
      }
    }
    if (js === -1 || je === -1) throw new Error('Could not parse options JSON')

    const opts = JSON.parse(afterUrl.slice(js, je))
    const headers = opts.headers || {}
    let body = {}
    if (opts.body && typeof opts.body === 'string') {
      try {
        body = JSON.parse(opts.body)
      } catch {
        body = {}
      }
    }
    return { headers, body, url: urlMatch[2] }
  }

  async _stepFetchInput() {
    const { raw } = await inquirer.prompt([
      {
        type: 'editor',
        name: 'raw',
        message: 'Paste fetch() call:',
        default: 'fetch("https://chatgpt.com/...", { ... })',
        validate: (v) => v.includes('fetch(') || 'Must be a valid fetch() call',
      },
    ])
    return raw?.trim() || null
  }

  _loadAll() {
    try {
      if (fs.existsSync(this._usersFile)) {
        return JSON.parse(fs.readFileSync(this._usersFile, 'utf8'))
      }
    } catch (e) {
      console.error('Load users error:', e.message)
    }
    return {}
  }

  _saveUser(provider, username, userData) {
    try {
      const all = this._loadAll()
      if (!all[provider]) all[provider] = {}
      all[provider][username] = userData
      const tmp = this._usersFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8')
      fs.renameSync(tmp, this._usersFile)
    } catch (e) {
      console.error('Save user error:', e.message)
    }
  }

  _formatTime(isoString) {
    if (!isoString) return 'never'
    try {
      const d = new Date(isoString)
      const mins = Math.floor((Date.now() - d) / 60000)
      if (mins < 1) return 'just now'
      if (mins < 60) return `${mins}m ago`
      if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
      return `${Math.floor(mins / 1440)}d ago`
    } catch {
      return 'unknown'
    }
  }

  async _prompt(choices) {
    try {
      const { session } = await inquirer.prompt([
        { type: 'list', name: 'session', message: 'Choose:', choices, pageSize: 10 },
      ])
      return session
    } catch {
      return null
    }
  }

  async _promptSessionName() {
    const defaultName = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const { name } = await inquirer.prompt([
      { type: 'input', name: 'name', message: 'Session name:', default: defaultName },
    ])
    return name?.trim() || null
  }

  async _confirmDeleteAll(count) {
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Delete all ${count} sessions? (Enter = Yes, Esc = Cancel)`,
        default: true,
      },
    ])
    return confirm
  }
}

module.exports = { SessionSelector }
