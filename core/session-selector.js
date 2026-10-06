'use strict'

const fs = require('fs')
const path = require('path')
const prompts = require('prompts')
const { spawn } = require('child_process')

const SYNTAX = require('../engine/syntax')
const registry = require('../providers/registry')
const usersState = require('./state/users')
const sessionsState = require('./state/sessions')

const { text } = require('../utils/log')

const BACKSLASH = String.fromCharCode(0x5c)

class SessionSelector {
  /**
   * @param {object} db - open SQLite handle (required for real use)
   */
  constructor(db) {
    this._db = db
  }

  async select(showRecent, provider, username, sessionName) {
    if (showRecent) {
      const continued = await this._stepContinueRecentSession()
      if (continued) return continued
    }

    this.provider = await this._stepProviderSelection(provider)
    if (!this.provider) return null

    this.user = await this._stepUserLogin(username)
    if (!this.user) return null

    const providerUsers = this._listUsersForProvider(this.provider)

    const waitPolicy = registry.get(this.provider)?.waitPolicy
    if (waitPolicy) {
      for (const u of providerUsers) {
        if (u.waitUntil && u.waitUntil <= Date.now()) {
          u.waitUntil = null
          u.waitReason = null
        }
      }

      while (this.user.waitUntil && this.user.waitUntil > Date.now()) {
        const mins = Math.ceil((this.user.waitUntil - Date.now()) / 60000)
        const resetsAt = this._formatResetTime(this.user.waitUntil)
        console.warn('\n' + waitPolicy.userMessage(this.user.username, resetsAt, mins) + '\n', 1)

        const availableUsers = providerUsers.filter(
          (u) => u.username !== this.user.username && (!u.waitUntil || u.waitUntil <= Date.now()),
        )

        if (availableUsers.length === 0) {
          const soonest = providerUsers
            .map((u) => ({ username: u.username, ts: u.waitUntil }))
            .filter((u) => u.ts)
            .sort((a, b) => a.ts - b.ts)[0]
          const minsLeft = Math.ceil((soonest.ts - Date.now()) / 60000)
          const resetsAtSoonest = this._formatResetTime(soonest.ts)
          console.error(
            '\n' + waitPolicy.allMessage(soonest.username, resetsAtSoonest, minsLeft) + '\n',
            1,
          )
          return this.select(false)
        }

        this.user = await this._stepUserLogin()
        if (!this.user) return null
      }
    }

    this.session = await this._stepSessionSelection(sessionName)
    if (!this.session) return null

    this.session.lastUsed = Date.now()

    return {
      user: this.user.username,
      userData: this.user,
      provider: this.provider,
      parsedFetch: this.user.parsedFetch || null,
      session: this.session,
      sessionName: this.session.name,
      sessionTags: this.formatSessionTags(this.session),
    }
  }

  async _stepContinueRecentSession() {
    const all = this._listAllUsers()
    const resolved = []

    for (const user of all) {
      const list = sessionsState.listForUser(this._db, user.id)
      for (const session of list) {
        if (session.lastUsed) {
          resolved.push({
            session,
            username: user.username,
            provider: user.provider,
          })
        }
      }
    }

    if (resolved.length === 0) return null

    resolved.sort((a, b) => (b.session.lastUsed || 0) - (a.session.lastUsed || 0))
    resolved.length = Math.min(resolved.length, 3)

    const choices = resolved.map((item, i) => ({
      title: item.session.name + ' - ' + item.provider + ' - ' + item.username + ' ',
      description: this.formatSessionTags(item.session, item.provider),
      value: i,
    }))

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

    const picked = resolved[choice]
    return this.select(false, picked.provider, picked.username, picked.session.name)
  }

  flush() {
    // Users and sessions are persisted by their own proxies on mutation.
    // Nothing to flush here.
  }

  async _stepProviderSelection(preset) {
    if (preset) return preset

    const providers = registry.getAll()
    const choices = providers.map((p) => ({
      title: p.displayName || p.name,
      value: p.name,
    }))

    const { provider } = await prompts(
      {
        type: 'select',
        name: 'provider',
        message: 'Select AI Provider',
        choices,
      },
      { onCancel: () => process.exit(0) },
    )
    return provider
  }

  async _stepUserLogin(preset) {
    const providerUsers = this._listUsersForProvider(this.provider)
    if (preset) {
      const found = providerUsers.find((u) => u.username === preset)
      if (found) return found
    }
    const savedUsers = providerUsers.map((u) => u.username)

    if (savedUsers.length > 0) {
      const choices = providerUsers.map((user) => {
        const limited =
          Boolean(registry.get(this.provider)?.waitPolicy) &&
          user.waitUntil &&
          user.waitUntil > Date.now()
        return {
          title: user.username,
          value: user.username,
          description: limited ? '⚠ at usage limit' : undefined,
        }
      })
      choices.push({ title: text.cyan('Create new user'), value: '__new__' })
      choices.push({ title: text.red('Delete user'), value: '__delete__' })

      const { username } = await prompts(
        {
          type: 'select',
          name: 'username',
          message: 'Select User (' + this.provider + ')',
          choices,
        },
        { onCancel: () => process.exit(0) },
      )

      if (username === '__new__') return this._promptNewUser()
      if (username === '__delete__') return this._deleteUser(savedUsers)
      return providerUsers.find((u) => u.username === username)
    }

    return this._promptNewUser()
  }

  _validateFetchHeaders(parsedFetch) {
    const provider = registry.get(this.provider)
    return provider?.validateFetch ? provider.validateFetch(parsedFetch) : []
  }

  async _validateLiveConnection(parsedFetch, username) {
    const provider = registry.get(this.provider)
    const result = await provider.validateCredentials(parsedFetch || {}, username)
    if (!result.success) throw new Error(result.error)
  }

  _openBrowser(url) {
    const cmd =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]]
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref()
  }

  _listAllUsers() {
    return usersState.list(this._db)
  }

  _listUsersForProvider(provider) {
    return this._listAllUsers().filter((u) => u.provider === provider)
  }

  _existingLocalKeys() {
    return this._listUsersForProvider(this.provider).map((u) => u.username.toLowerCase())
  }

  _profileDirFor(username) {
    return path.join(__dirname, '..', 'temp', 'profiles', this.provider, username)
  }

  _validateLocalKey(raw) {
    const v = String(raw || '')
      .trim()
      .toLowerCase()
    if (!v) return 'Username is required'
    if (!/^[a-z0-9]{1,32}$/.test(v)) {
      return 'Alphanumeric only (a-z, 0-9), 1-32 chars'
    }
    if (this._existingLocalKeys().includes(v)) {
      return 'User "' + v + '" already exists - pick another key or delete it first'
    }
    if (fs.existsSync(this._profileDirFor(v))) {
      return 'Profile dir for "' + v + '" already exists - pick another key or delete it manually'
    }
    return true
  }

  async _promptNewUser() {
    console.info('\n  -- Create New User --\n', 1)

    const { username: rawUsername } = await prompts(
      {
        type: 'text',
        name: 'username',
        message: 'Username (local key, a-z 0-9, immutable)',
        validate: (v) => this._validateLocalKey(v),
      },
      { onCancel: () => process.exit(0) },
    )

    if (!rawUsername) return null
    const username = String(rawUsername).trim().toLowerCase()

    const provider = registry.get(this.provider)
    const providerUrl = provider.setupSteps?.url
    if (providerUrl) {
      console.debug.mix('\n  Opening ' + text.blue(providerUrl) + ' in your browser...', 1)
      this._openBrowser(providerUrl)
    }

    const steps = []
    if (provider.setupSteps) {
      steps.push('  1. Open DevTools (F12) - Network tab')
      steps.push('  2. Start a conversation')
      steps.push('  3. Find a request to ' + text.cyan(provider.setupSteps.requestFilter))
      steps.push('  4. Right-click - Copy - Copy as fetch')
    }

    console.debug('\n  Paste the full fetch() call from browser DevTools:', 1)
    steps.forEach((s) => console.debug.mix(s, 1))
    console.debug('', 1)

    while (true) {
      console.debug(
        '  Notepad will open - paste your fetch() call, save (Ctrl+S), close Notepad.\n',
        1,
      )
      const fetchStr = await this._openEditor()

      if (!fetchStr || !fetchStr.includes('fetch(')) {
        if (!(await this._retryOrCancel('✖ Not a valid fetch() call - what would you like to do?')))
          return null
        continue
      }

      let parsedFetch
      try {
        parsedFetch = this._parseFetchDirect(fetchStr)
      } catch (e) {
        console.error('  ✖ Failed to parse fetch: ' + e.message + '\n', e, 1)
        continue
      }

      const missing = this._validateFetchHeaders(parsedFetch)
      if (missing.length > 0) {
        console.error(
          '  ✖ Fetch is missing required headers:\n' +
            missing.map((h) => '     - ' + h).join('\n') +
            '\n',
          1,
        )
        if (
          !(await this._retryOrCancel(
            'Make sure you copied the right request - what would you like to do?',
          ))
        )
          return null
        continue
      }

      process.stdout.write(text.dim('  Validating browser session...'))
      try {
        await this._validateLiveConnection(parsedFetch, username)
        process.stdout.write('\r                                  ')
        process.stdout.write('\r  ' + text.green('√ Session verified') + '\n\n')
      } catch (e) {
        process.stdout.write(' \n\n')
        console.error('  ✖ Live check failed: ' + e.message + '\n', e, 1)
        if (
          !(await this._retryOrCancel(
            'Credentials rejected by provider - what would you like to do?',
          ))
        )
          return null
        continue
      }

      return usersState.create(this._db, this.provider, username, { parsedFetch })
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

  async _stepSessionSelection(preset) {
    const list = this._listSessionsForCurrentUser()

    if (preset) {
      const found = list.find((s) => s.name === preset)
      if (found) return found
    }

    const choices = list.map((s) => ({
      title: s.name,
      description: this.formatSessionTags(s),
      value: s.name,
    }))

    choices.push({ title: text.cyan('Create new session'), value: '__new__' })
    if (list.length > 0) {
      choices.push({ title: text.red('Delete all sessions'), value: '__delete_all__' })
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
    if (result === '__new__') return this._createNewSession()
    if (result === '__delete_all__') return this._deleteAllSessions()
    return list.find((s) => s.name === result)
  }

  _listSessionsForCurrentUser() {
    if (!this.user || !this.user.id) return []
    return sessionsState.listForUser(this._db, this.user.id)
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
          {
            title: text.cyan('Tools Mode'),
            description: SYNTAX.NAME + ' agent - recommended',
            value: true,
          },
          { title: 'Raw Mode', description: 'Plain chat, no tools', value: false },
        ],
      },
    ]

    const providerDef = registry.get(this.provider)
    const providerModels = providerDef?.models || {}
    const modelEntries = Object.entries(providerModels.models || {})

    if (modelEntries.length > 0) {
      const label = providerModels.title || providerDef.displayName || this.provider
      questions.push({
        type: 'select',
        name: 'model',
        message: label + ' model',
        choices: modelEntries.map(([value, meta]) => ({
          title: meta.name,
          value,
          description: meta.recommendedForTools ? 'recommended for tools' : undefined,
        })),
      })
    }

    const answers = await prompts(questions, { onCancel: () => process.exit(0) })
    if (!answers.name) return null

    const modelMeta = providerModels.models?.[answers.model]
    const vision = modelMeta?.vision ?? Boolean(providerDef.defaultVision)

    if (!this.user || !this.user.id) {
      return {
        name: answers.name || defaultName,
        toolCalling: answers.toolCalling ?? true,
        vision,
        model: answers.model,
      }
    }

    return sessionsState.create(this._db, this.user.id, {
      name: answers.name || defaultName,
      toolCalling: answers.toolCalling ?? true,
      vision,
      model: answers.model,
    })
  }

  async _deleteUser(savedUsers) {
    const { target } = await prompts(
      {
        type: 'select',
        name: 'target',
        message: 'Delete which user (' + this.provider + ')?',
        choices: [
          ...savedUsers.map((u) => ({ title: text.red(u), value: u })),
          { title: 'Back', value: '__back__' },
        ],
      },
      { onCancel: () => process.exit(0) },
    )

    if (!target || target === '__back__') return this._stepUserLogin()

    const providerUsers = this._listUsersForProvider(this.provider)
    const targetUser = providerUsers.find((u) => u.username === target)
    if (!targetUser) return this._stepUserLogin()

    const sessionCount = this._db ? sessionsState.listForUser(this._db, targetUser.id).length : 0
    const { confirmed } = await prompts(
      {
        type: 'confirm',
        name: 'confirmed',
        message:
          'Delete user "' +
          target +
          '" and ' +
          sessionCount +
          ' local session(s)? This also deletes all provider-side sessions.',
        initial: false,
      },
      { onCancel: () => process.exit(0) },
    )

    if (!confirmed) return this._stepUserLogin()

    const savedUser = this.user
    const savedProvider = this.provider

    this.user = targetUser
    process.stdout.write(text.dim('  Deleting provider sessions...'))
    try {
      await this._deleteProviderSessions()
    } catch (e) {
      console.warn('\n  Provider cleanup failed: ' + e.message)
    }
    process.stdout.write(
      '\r  ' + text.green('√ Provider sessions cleaned.') + '                  \n',
    )

    this.user = savedUser
    this.provider = savedProvider

    if (this._db) {
      usersState.remove(this._db, targetUser.id)
    }
    try {
      fs.rmSync(this._profileDirFor(target.toLowerCase()), { recursive: true, force: true })
    } catch (e) {
      console.warn('  Failed to remove profile dir: ' + e.message)
    }
    console.info('  ' + text.green('√') + ' User "' + target + '" removed.\n')

    return this._stepUserLogin()
  }

  async _deleteAllSessions() {
    const list = this._listSessionsForCurrentUser()
    const count = list.length
    const { confirmed } = await prompts(
      {
        type: 'confirm',
        name: 'confirmed',
        message: 'Delete all ' + count + ' sessions?',
        initial: true,
      },
      { onCancel: () => process.exit(0) },
    )

    if (confirmed) {
      process.stdout.write(text.dim('  Deleting sessions...'))
      await this._deleteProviderSessions()
      process.stdout.write('\r  ' + text.green('√ Done.') + '                  \n\n')

      if (this._db && this.user && this.user.id) {
        sessionsState.removeAllForUser(this._db, this.user.id)
      }
    }

    return this._stepSessionSelection()
  }

  async _deleteProviderSessions() {
    const provider = registry.get(this.provider)
    const api = provider.createAPI({ log: false })
    await api.initializeFromJSON(this.user.parsedFetch || {})

    const list = this._listSessionsForCurrentUser()
    const toDelete = list.filter((s) => s.id)
    if (toDelete.length === 0) return

    let deleted = 0
    process.stdout.write('\r                                      ')
    for (const session of toDelete) {
      try {
        deleted++
        process.stdout.write(text.dim('\r  Deleting ' + deleted + '/' + toDelete.length))
        await api.deleteSession(session.id)
      } catch (e) {
        console.warn('\n  Failed ' + session.id + ': ' + e.message)
      }
    }
  }

  _openEditor() {
    return new Promise((resolve) => {
      const os = require('os')
      const tmp = path.join(os.tmpdir(), 'zerokey-fetch-' + Date.now() + '.js')
      fs.writeFileSync(tmp, '', 'utf8')
      const editor = process.platform === 'win32' ? 'notepad' : process.env.EDITOR || 'nano'
      const { spawnSync } = require('child_process')
      spawnSync(editor, [tmp], { stdio: 'inherit' })
      try {
        const content = fs.readFileSync(tmp, 'utf8').trim()
        fs.unlinkSync(tmp)
        resolve(content.length > 0 ? content : null)
      } catch {
        // Editor wrote nothing or the temp file is gone; treat as cancel.
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

    let depth = 0
    let inStr = false
    let sc = ''
    let js = -1
    let je = -1
    for (let i = optStart; i < afterUrl.length; i++) {
      const c = afterUrl[i]
      if (inStr) {
        if (c === BACKSLASH) {
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

  _formatResetTime(ts) {
    const d = new Date(ts)
    const now = new Date()
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    return sameDay ? d.toLocaleTimeString() : d.toLocaleString()
  }

  _formatTime(isoString) {
    if (!isoString) return 'never'
    try {
      const d = typeof isoString === 'number' ? new Date(isoString) : new Date(isoString)
      const mins = Math.floor((Date.now() - d) / 60000)
      if (mins < 1) return 'just now'
      if (mins < 60) return mins + 'm ago'
      if (mins < 1440) return Math.floor(mins / 60) + 'h ago'
      return Math.floor(mins / 1440) + 'd ago'
    } catch {
      return 'unknown'
    }
  }

  _modelName(provider, modelKey) {
    if (!modelKey) return ''
    const providerDef = registry.get(provider)
    const meta = providerDef?.models?.models?.[modelKey]
    return meta ? meta.name : modelKey
  }

  formatSessionTags(session, provider) {
    const p = provider || this.provider
    return [
      this._modelName(p, session.model),
      session.toolCalling ? 'tools' : 'no tools',
      session.vision ? 'vision' : 'no vision',
      session.lastUsed ? 'last: ' + this._formatTime(session.lastUsed) : '',
    ]
      .filter(Boolean)
      .join('  ·  ')
  }
}

module.exports = { SessionSelector }
