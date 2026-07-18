const fs = require('fs')
const path = require('path')
const prompts = require('prompts')
const { ClaudeAPI } = require('./claude/api')
const { DeepSeekAPI } = require('./deepseek/api')
const { ChatGPTAPI } = require('./chatgpt/api')
const { MODEL_HASH } = require('../config/constants')
const { text } = require('../utils/logger')

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
    const continued = await this._stepContinueRecentSession()
    if (continued) return continued

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
    this._pushRecentSession(this.provider, this.user.username, this.session.name)

    return {
      user: this.user.username,
      userData: this.user,
      provider: this.provider,
      parsedFetch: this.user.parsedFetch || null,
      session: this.session,
      sessionName: this.session.name,
    }
  }

  async _stepContinueRecentSession() {
    const all = this._loadAll()
    const recent = Array.isArray(all.recentSessions) ? all.recentSessions : []
    if (recent.length === 0) return null

    const resolved = []
    for (const entry of recent) {
      const providerUsers = all[entry.provider] || {}
      const user = providerUsers[entry.username]
      if (!user) continue
      const session = (user.sessions || []).find((s) => s.name === entry.sessionName)
      if (!session) continue
      resolved.push({ entry, user, session })
    }
    if (resolved.length === 0) return null

    const choices = resolved.map(({ entry, session }, i) => {
      const tags = [
        this._modelName(entry.provider, session.model),
        session.toolCalling ? 'tools' : 'no tools',
        session.vision ? 'vision' : 'no vision',
        `last: ${this._formatTime(session.lastUsed)}`,
      ]
        .filter(Boolean)
        .join('  ·  ')

      return {
        title: `${entry.username} · ${entry.provider} · ${entry.sessionName} `,
        description: tags,
        value: i,
      }
    })
    choices.unshift({ title: text.cyan('No, Show Menu'), value: -1 })

    const { choice } = await prompts(
      {
        type: 'select',
        name: 'choice',
        message: 'Continue with a recent session?',
        choices,
      },
      { onCancel: () => process.exit(0) },
    )

    if (choice === undefined || choice === -1) return null

    const { entry, user, session } = resolved[choice]
    this.provider = entry.provider
    this.user = user
    if (!this.user.sessions) this.user.sessions = []
    this.session = session

    this._saveUser(this.provider, this.user.username, this.user)
    this._pushRecentSession(this.provider, this.user.username, this.session.name)

    return {
      user: this.user.username,
      userData: this.user,
      provider: this.provider,
      parsedFetch: this.user.parsedFetch || null,
      session: this.session,
      sessionName: this.session.name,
    }
  }

  _pushRecentSession(provider, username, sessionName) {
    try {
      const all = this._loadAll()
      let recent = Array.isArray(all.recentSessions) ? all.recentSessions : []
      recent = recent.filter(
        (e) =>
          !(e.provider === provider && e.username === username && e.sessionName === sessionName),
      )
      recent.unshift({ provider, username, sessionName })
      all.recentSessions = recent.slice(0, 3)
      const tmp = this._usersFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8')
      fs.renameSync(tmp, this._usersFile)
    } catch (e) {
      console.error('Save recentSessions error:', e.message)
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
      choices.push({ title: text.cyan('Create new user'), value: '__new__' })

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

  _validateFetchHeaders(parsedFetch) {
    const h = Object.fromEntries(
      Object.entries(parsedFetch.headers).map(([k, v]) => [k.toLowerCase(), v]),
    )
    const b = parsedFetch.body || {}
    const url = parsedFetch.url || ''
    const errors = []

    if (this.provider === 'deepseek') {
      if (!h['cookie']) errors.push('cookie — required for session auth')
      if (!h['authorization']) errors.push('authorization — required (Bearer token)')
      if (!url.endsWith('/api/v0/chat/completion'))
        errors.push('URL must be /api/v0/chat/completion — wrong request copied')
    }

    if (this.provider === 'claude') {
      if (!h['cookie']) errors.push('cookie — required for session auth')
      if (!h['anthropic-device-id'])
        errors.push('anthropic-device-id — missing; copy from the /completion request on claude.ai')
      if (!/\/organizations\/[a-f0-9-]{36}/i.test(url))
        errors.push(
          'URL must contain /organizations/<uuid>/chat_conversations — wrong request copied',
        )
      if (!url.endsWith('/completion'))
        errors.push(
          'URL must end in /completion — copy the streaming completion request, not a GET',
        )
    }

    if (this.provider === 'chatgpt') {
      if (!h['cookie']) errors.push('cookie — required for session auth')
      if (!h['authorization']) errors.push('authorization — required (Bearer token)')
      if (!h['openai-sentinel-proof-token'])
        errors.push(
          'openai-sentinel-proof-token — missing; copy /backend-api/f/conversation, not a /sentinel/ request',
        )
      if (!h['oai-language'])
        errors.push('oai-language — missing; copy from /backend-api/f/conversation request')
      if (!h['oai-device-id'])
        errors.push('oai-device-id — missing; copy from /backend-api/f/conversation request')
      if (!url.endsWith('/backend-api/f/conversation'))
        errors.push('URL must be /backend-api/f/conversation — wrong request copied')
      if (!b['client_contextual_info'])
        errors.push(
          'body.client_contextual_info — missing; copy /backend-api/f/conversation, not /prepare or /sentinel/',
        )
    }

    return errors
  }

  async _validateLiveConnection(parsedFetch) {
    const cfg = this._getProvider(parsedFetch, this.provider, { log: false })
    const api = cfg.factory()
    await cfg.init(api)

    if (this.provider === 'deepseek') {
      await api.getCurrentUser()
      return
    }

    if (this.provider === 'claude') {
      await api.getAccountProfile()
      return
    }

    if (this.provider === 'chatgpt') {
      await api.getMe()
    }
  }

  _openBrowser(url) {
    const { spawn } = require('child_process')
    const cmd =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]]
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref()
  }

  async _promptNewUser() {
    console.info('\n  ── Create New User ──\n')

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

    const PROVIDER_URLS = {
      deepseek: 'https://chat.deepseek.com',
      claude: 'https://claude.ai/new',
      chatgpt: 'https://chatgpt.com',
    }

    const providerUrl = PROVIDER_URLS[this.provider]
    if (providerUrl) {
      console.debug.mix(`\n  Opening ${text.blue(providerUrl)} in your browser...`)
      this._openBrowser(providerUrl)
    }

    const PROVIDER_STEPS = {
      deepseek: [
        '  1. Open DevTools (F12) → Network tab',
        '  2. Send any message on chat.deepseek.com',
        `  3. Find a request to ${text.cyan('/api/v0/chat/completion')}`,
        '  4. Right-click → Copy → Copy as fetch',
      ],
      claude: [
        '  1. Open DevTools (F12) → Network tab',
        '  2. Send any message on claude.ai',
        `  3. Find a request to ${text.cyan('/api/organizations/.../completion')}`,
        '  4. Right-click → Copy → Copy as fetch',
      ],
      chatgpt: [
        '  1. Open DevTools (F12) → Network tab',
        '  2. Send any message on chatgpt.com',
        `  3. Find a request to ${text.cyan('/backend-api/f/conversation')}`,
        '  4. Right-click → Copy → Copy as fetch',
      ],
    }

    const steps = PROVIDER_STEPS[this.provider] || []
    console.debug('\n  Paste the full fetch() call from browser DevTools:')
    steps.forEach((s) => console.debug.mix(s))
    console.debug('')

    while (true) {
      console.debug(
        '  Notepad will open — paste your fetch() call, save (Ctrl+S), close Notepad.\n',
      )
      const fetchStr = await this._openEditor()

      if (!fetchStr || !fetchStr.includes('fetch(')) {
        if (!(await this._retryOrCancel('✖ Not a valid fetch() call — what would you like to do?')))
          return null
        continue
      }

      let parsedFetch
      try {
        parsedFetch = this._parseFetchDirect(fetchStr)
      } catch (e) {
        console.error(`  ✖ Failed to parse fetch: ${e.message}\n`)
        continue
      }

      const missing = this._validateFetchHeaders(parsedFetch)
      if (missing.length > 0) {
        console.error(
          `  ✖ Fetch is missing required headers:\n${missing.map((h) => `     • ${h}`).join('\n')}\n`,
        )
        if (
          !(await this._retryOrCancel(
            'Make sure you copied the right request — what would you like to do?',
          ))
        )
          return null
        continue
      }

      process.stdout.write(text.dim('  Validating browser session...'))
      try {
        await this._validateLiveConnection(parsedFetch)
        process.stdout.write('\r                                  ')
        process.stdout.write('\r  ' + text.green('√ Session verified') + '\n\n')
      } catch (e) {
        process.stdout.write(' ✖\n\n')
        console.error(`  ✖ Live check failed: ${e.message}\n`)
        if (
          !(await this._retryOrCancel(
            'Credentials rejected by provider — what would you like to do?',
          ))
        )
          return null
        continue
      }

      const user = { username, parsedFetch, sessions: [] }
      this._saveUser(this.provider, username, user)
      return user
    }
  }

  async _retryOrCancel(message) {
    const { invalidAction } = await prompts(
      {
        type: 'select',
        name: 'invalidAction',
        message,
        choices: [
          { title: text.cyan('Try again'), value: 'retry' },
          { title: text.red('Cancel'), value: 'cancel' },
        ],
      },
      { onCancel: () => process.exit(0) },
    )
    return invalidAction === 'retry'
  }

  async _stepSessionSelection() {
    const sessions = this.user.sessions || []

    const choices = sessions.map((s, i) => {
      const tags = [
        this._modelName(this.provider, s.model),
        s.toolCalling ? 'tools' : 'no tools',
        s.vision ? 'vision' : 'no vision',
        `last: ${this._formatTime(s.lastUsed)}`,
      ]
        .filter(Boolean)
        .join('  ·  ')
      return { title: s.name, description: tags, value: i }
    })

    choices.push({ title: text.cyan('Create new session'), value: -1 })
    if (sessions.length > 0) {
      choices.push({ title: text.red('Delete all sessions'), value: -2 })
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
          { title: text.cyan('Tools Mode'), description: 'BPI agent — recommended', value: true },
          { title: 'Raw Mode', description: 'Plain chat, no tools', value: false },
        ],
      },
    ]

    const MODEL_DESCRIPTIONS = {
      claude: { 'claude-sonnet-4-6': 'recommended for tools' },
      chatgpt: { auto: 'recommended' },
      deepseek: { expert: 'recommended' },
    }

    if (this.provider === 'claude' || this.provider === 'chatgpt' || this.provider === 'deepseek') {
      const providerHash = MODEL_HASH[this.provider] || {}
      const label = providerHash.title || this.provider
      const descriptions = MODEL_DESCRIPTIONS[this.provider] || {}
      questions.push({
        type: 'select',
        name: 'model',
        message: `${label} model`,
        choices: Object.entries(providerHash.models || {}).map(([value, meta]) => ({
          title: meta.name,
          value,
          description: descriptions[value],
        })),
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
        initial: true,
      },
      { onCancel: () => process.exit(0) },
    )

    if (!confirmed) return this._stepSessionSelection()

    process.stdout.write(text.dim('  Deleting sessions...'))
    await this._deleteProviderSessions()
    process.stdout.write('\r  ' + text.green('√ Done.') + '                  \n\n')

    this.user.sessions = []
    return this._stepSessionSelection()
  }

  _getProvider(parsedFetch, provider, options = {}) {
    const providers = {
      deepseek: {
        label: 'DeepSeek',
        factory: () => new DeepSeekAPI(options),
        init: (api) => api.initialize(parsedFetch?.headers || {}),
      },
      claude: {
        label: 'Claude',
        factory: () => new ClaudeAPI(options),
        init: (api) => api.initializeFromJSON(parsedFetch || {}),
      },
      chatgpt: {
        label: 'ChatGPT',
        factory: () => new ChatGPTAPI(options),
        init: (api) => api.initializeFromJSON(parsedFetch || {}),
      },
    }

    const cfg = providers[provider]
    if (!cfg) throw new Error(`Unknown provider: ${provider}`)
    return cfg
  }

  async _deleteProviderSessions() {
    const cfg = this._getProvider(this.user.parsedFetch, this.provider, { log: false })

    const toDelete = this.user.sessions.filter((s) => s.chatSessionId)
    if (toDelete.length === 0) return

    const api = cfg.factory()
    await cfg.init(api)

    let deleted = 0
    process.stdout.write('\r                                      ')
    for (const session of toDelete) {
      try {
        deleted++
        process.stdout.write(text.dim(`\r  Deleting ${deleted}/${toDelete.length}`))
        await api.deleteSession(session.chatSessionId)
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

  _modelName(provider, modelKey) {
    if (!modelKey) return ''
    const meta = MODEL_HASH[provider]?.models?.[modelKey]
    return meta ? meta.name : modelKey
  }
}

module.exports = { SessionSelector }
