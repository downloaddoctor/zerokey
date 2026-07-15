const fs = require('fs')
const path = require('path')
const prompts = require('prompts')
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

      for (const u of Object.values(providerUsers)) {
        if (u.waitUntil && u.waitUntil <= Date.now()) {
          delete u.waitUntil
          delete u.waitReason
        }
      }

      while (this.user.waitUntil && this.user.waitUntil > Date.now()) {
        const mins = Math.ceil((this.user.waitUntil - Date.now()) / 60000)
        const resetsAt = new Date(this.user.waitUntil).toLocaleTimeString()
        console.warn(
          `\n⚠  User "${this.user.username}" is at limit. Resets at ${resetsAt} (~${mins} min).\n`,
        )

        const availableUsers = Object.values(providerUsers).filter(
          (u) => u.username !== this.user.username && (!u.waitUntil || u.waitUntil <= Date.now()),
        )

        if (availableUsers.length === 0) {
          const soonest = Object.values(providerUsers)
            .map((u) => ({ username: u.username, ts: u.waitUntil }))
            .filter((u) => u.ts)
            .sort((a, b) => a.ts - b.ts)[0]
          const minsLeft = Math.ceil((soonest.ts - Date.now()) / 60000)
          const resetsAtSoonest = new Date(soonest.ts).toLocaleTimeString()
          console.error(
            `\n⚠ All Claude users are at their usage limit.\n` +
              `    Soonest reset: "${soonest.username}" at ${resetsAtSoonest} (~${minsLeft} min).\n`,
          )
          return this.select()
        }

        this.user = await this._stepUserLogin()
        if (!this.user) return null
      }
    }

    this.session = await this._stepSessionSelection()
    if (!this.session) return null

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

  flush() {
    if (this.provider && this.user) {
      this._saveUser(this.provider, this.user.username, this.user)
    }
  }

  async _stepProviderSelection() {
    const { provider } = await prompts(
      {
        type: 'select',
        name: 'provider',
        message: 'Select AI Provider',
        choices: [
          { title: 'DeepSeek', value: 'deepseek' },
          { title: 'Claude', value: 'claude' },
          { title: 'ChatGPT', value: 'chatgpt' },
        ],
      },
      { onCancel: () => process.exit(0) },
    )
    return provider
  }

  async _stepUserLogin() {
    const allProviders = this._loadAll()
    const providerUsers = allProviders[this.provider] || {}
    const savedUsers = Object.keys(providerUsers)

    if (savedUsers.length > 0) {
      const choices = savedUsers.map((username) => {
        const user = providerUsers[username]
        const limited = this.provider === 'claude' && user.waitUntil && user.waitUntil > Date.now()
        return {
          title: username,
          value: username,
          description: limited ? '⚠ at usage limit' : undefined,
        }
      })
      choices.push({ title: '＋ Create new user...', value: '__new__' })

      const { username } = await prompts(
        {
          type: 'select',
          name: 'username',
          message: `Select User (${this.provider})`,
          choices,
        },
        { onCancel: () => process.exit(0) },
      )

      if (username === '__new__') return this._promptNewUser()
      return providerUsers[username]
    }

    return this._promptNewUser()
  }

  async _promptNewUser() {
    console.log('\n  ── Create New User ──\n')

    const { username } = await prompts(
      {
        type: 'text',
        name: 'username',
        message: 'Username',
        validate: (v) => v.trim().length > 0 || 'Username is required',
      },
      { onCancel: () => process.exit(0) },
    )

    if (!username) return null

    console.log(
      '\n  Paste the full fetch() call from browser DevTools:\n' +
        '  DevTools → Network → Find a "conversation" request\n' +
        '  Right-click → Copy → Copy as fetch\n',
    )

    while (true) {
      console.log('  Notepad will open — paste your fetch() call, save (Ctrl+S), close Notepad.\n')
      const fetchStr = await this._openEditor()
      if (!fetchStr) {
        console.log('  Cancelled.')
        return null
      }

      if (!fetchStr.includes('fetch(')) {
        console.error('  ✖ Must be a valid fetch() call — try again.\n')
        continue
      }

      let parsedFetch
      try {
        parsedFetch = this._parseFetchDirect(fetchStr)
      } catch (e) {
        console.error(`  ✖ Failed to parse fetch: ${e.message}\n`)
        continue
      }

      const { action } = await prompts(
        {
          type: 'select',
          name: 'action',
          message: `Parsed OK — ${Object.keys(parsedFetch.headers).length} headers. What next?`,
          choices: [
            { title: '✔  Use this user', value: 'use' },
            { title: '↩  Re-enter fetch', value: 'retry' },
            { title: '✖  Cancel', value: 'cancel' },
          ],
        },
        { onCancel: () => process.exit(0) },
      )

      if (!action || action === 'cancel') return null
      if (action === 'retry') continue

      const user = { username, parsedFetch, sessions: [] }
      this._saveUser(this.provider, username, user)
      return user
    }
  }

  async _stepSessionSelection() {
    const sessions = this.user.sessions || []

    const choices = sessions.map((s, i) => {
      const tags = [
        s.model || '',
        s.toolCalling ? 'tools' : 'no tools',
        s.vision ? 'vision' : 'no vision',
        `last: ${this._formatTime(s.lastUsed)}`,
      ]
        .filter(Boolean)
        .join('  ·  ')
      return { title: s.name, description: tags, value: i }
    })

    choices.push({ title: '＋ Create new session...', value: -1 })
    if (sessions.length > 0) {
      choices.push({ title: '🗑  Delete all sessions...', value: -2 })
    }

    const { result } = await prompts(
      {
        type: 'select',
        name: 'result',
        message: 'Choose session',
        choices,
      },
      { onCancel: () => process.exit(0) },
    )

    if (result === undefined) return null
    if (result === -1) return this._createNewSession()
    if (result === -2) return this._deleteAllSessions()
    return this.user.sessions[result]
  }

  async _createNewSession() {
    const defaultName = new Date().toISOString().slice(0, 19).replace('T', ' ')

    const questions = [
      {
        type: 'text',
        name: 'name',
        message: 'Session name',
        initial: defaultName,
      },
      {
        type: 'select',
        name: 'toolCalling',
        message: 'Session mode',
        choices: [
          { title: 'Tools Mode', description: 'BPI agent — recommended', value: true },
          { title: 'Raw Mode', description: 'Plain chat, no tools', value: false },
        ],
      },
    ]

    if (this.provider === 'claude') {
      questions.push({
        type: 'select',
        name: 'model',
        message: 'Claude model',
        choices: [
          { title: 'SONNET 4.6', description: 'recommended for tools', value: 'claude-sonnet-4-6' },
          { title: 'SONNET 5', value: 'claude-sonnet-5' },
          { title: 'HAIKU 4.5', value: 'claude-haiku-4-5-20251001' },
        ],
      })
    } else if (this.provider === 'chatgpt') {
      questions.push({
        type: 'select',
        name: 'model',
        message: 'ChatGPT model',
        choices: [{ title: 'auto', description: 'recommended', value: 'auto' }],
      })
    } else if (this.provider === 'deepseek') {
      questions.push({
        type: 'select',
        name: 'model',
        message: 'DeepSeek model',
        choices: [
          { title: 'V4 - Expert', description: 'recommended', value: 'expert' },
          { title: 'V4 - Instant', value: 'default' },
          { title: 'V4 - Vision', value: 'vision' },
        ],
      })
    }

    const answers = await prompts(questions, { onCancel: () => process.exit(0) })
    if (!answers.name) return null

    const vision =
      this.provider === 'claude' ||
      this.provider === 'chatgpt' ||
      (this.provider === 'deepseek' && answers.model !== 'expert')

    const newSession = {
      name: answers.name || defaultName,
      chatSessionId: null,
      parentMessageId: null,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      toolCalling: answers.toolCalling ?? true,
      vision,
      model: answers.model,
    }

    this.user.sessions.push(newSession)
    return newSession
  }

  async _deleteAllSessions() {
    const count = this.user.sessions.length
    const { confirmed } = await prompts(
      {
        type: 'confirm',
        name: 'confirmed',
        message: `Delete all ${count} sessions?`,
        initial: false,
      },
      { onCancel: () => process.exit(0) },
    )

    if (!confirmed) return this._stepSessionSelection()

    process.stdout.write('  Deleting sessions...')
    await this._deleteProviderSessions()
    process.stdout.write(' done.\n\n')

    this.user.sessions = []
    return this._stepSessionSelection()
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

    let deleted = 0
    for (const session of toDelete) {
      try {
        await api.deleteSession(session.chatSessionId)
        deleted++
        process.stdout.write(`\r  Deleted ${deleted}/${toDelete.length}...`)
      } catch (e) {
        console.warn(`\n  ⚠ Failed ${session.chatSessionId}: ${e.message}`)
      }
    }
  }

  _openEditor() {
    return new Promise((resolve) => {
      const os = require('os')
      const tmp = path.join(os.tmpdir(), `zerokey-fetch-${Date.now()}.js`)
      fs.writeFileSync(tmp, '', 'utf8')
      const editor = process.platform === 'win32' ? 'notepad' : process.env.EDITOR || 'nano'
      const { spawnSync } = require('child_process')
      spawnSync(editor, [tmp], { stdio: 'inherit' })
      try {
        const content = fs.readFileSync(tmp, 'utf8').trim()
        fs.unlinkSync(tmp)
        resolve(content.length > 0 ? content : null)
      } catch {
        resolve(null)
      }
    })
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
}

module.exports = { SessionSelector }
