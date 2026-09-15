const SYNTAX = require('./syntax')
const ToolCompiler = require('./compiler')
const { toOpenAIError } = require('../utils/errors')
const { LogSaver, serializeError } = require('../utils/log-saver')

const routeErrorLog = new LogSaver({ name: 'errors', maxSize: 1024 * 1024 })
const {
  restoreMcpInjections,
  showAvailableMcpTags,
  handleSkill,
  registerAutoMcpServers,
} = require('./triggers')
const { isRealChatSession } = require('../utils/session-classifier')
const { ephemeralSession } = require('../utils/ephemeral-session')

let callCounter = 0

function buildCall(index, tool, funcName, args) {
  callCounter++
  const id = String(callCounter).padStart(4, '0')
  return {
    index,
    id: `call_${id}_${tool}`,
    type: 'function',
    function: {
      name: funcName,
      arguments: JSON.stringify(args),
    },
  }
}

function buildToolDelta(tool_calls) {
  return {
    role: 'assistant',
    content: null,
    tool_calls,
  }
}

const TODO_TOOLS = new Set(['todos_add', 'todos_set'])

function emitToolCalls(compiler, session, payloads, emit) {
  const compiled = payloads
    .flatMap((payload) => {
      const func = compiler.compile(payload, session)
      if (!func) return []
      return Array.isArray(func) ? func : [func]
    })
    .filter(Boolean)

  if (!compiled.length) return

  const ordered = []
  let todoGroup = []

  for (const f of compiled) {
    if (TODO_TOOLS.has(f.tool)) {
      todoGroup.push(f)
    } else {
      if (todoGroup.length) {
        ordered.push(todoGroup.pop())
        todoGroup = []
      }
      ordered.push(f)
    }
  }
  // Flush any remaining todo group at the end.
  if (todoGroup.length) ordered.push(todoGroup.pop())

  const tool_calls = ordered.map((f, i) => buildCall(i, f.tool, f.name, f.arguments))

  if (!tool_calls.length) return

  const delta = buildToolDelta(tool_calls)
  console.debug('[TOOL] EMIT', delta.tool_calls)
  emit(delta)
}

class StreamPipeline {
  static setSSEHeaders(res) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', '*')
  }

  /**
   * @param {import('express').Response} res
   * @param {object} session
   * @param {string} provider - 'deepseek' | 'claude' | 'chatgpt'
   * @param {string} ideName - 'vscode' | 'terax' | 'opencode'
   * @param {Array} [messages] - req.body.messages; when supplied, classifies
   *   this request as a real chat turn vs an ephemeral utility call
   *   (title-gen, tool-optimizer, etc.) via isRealChatSession. Ephemeral
   *   calls get a disposable session clone and rawMode=true (skips
   *   instructions/skill/MCP-tag setup and the block tool-parser — see setup()
   *   and scan()). Omit `messages` to always use the real session (e.g. for
   *   the title-gen short-circuit itself, which is already ephemeral by
   *   construction).
   */
  constructor(res, session, provider, ideName, messages = []) {
    this.compiler = new ToolCompiler(ideName, provider)

    const isReal = isRealChatSession(ideName, messages)

    this.res = res
    this.provider = provider
    this.session = isReal ? session : ephemeralSession(session)

    this.isNewSession = this.session.parentMessageId == null
    this.toolCalling = this.session.toolCalling ?? false
    this.haveInstructionsAPI = false
    this.ephemeralMode = !isReal
    this.rawMode = this.ephemeralMode ? true : !this.toolCalling

    this.inTool = false
    this.toolStartFound = false
    this.buffer = ''
    this.toolBuffers = []
    this.toolIndex = this.compiler.tools
    this.lastChar = ''
    this._maxToolLen = Math.max(...Object.keys(this.compiler.tools).map((k) => k.length)) + 3

    const chunk = {
      id: `chatcmpl-${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: this.compiler.provider,
      choices: [],
    }

    this.emit = (delta, finishReason = null, usage = null) => {
      chunk.choices = [{ index: 0, delta, finish_reason: finishReason, logprobs: null }]

      if (usage != null) {
        chunk.usage = usage
      }

      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }

    this.tokenUsage = {}
    this._finished = false

    // bindUploader curries the API's uploadFile — must be set per-request.
    this.bindUploader = (api, collector) => {
      this.upload = (file) => this._uploadFile(api.uploadFile.bind(api), file, collector)
    }
  }

  upload(_file) {}

  // ── public emit methods ────────────────────────────────────────────────
  emit(delta, _finishReason = null, _usage = null) {}

  emitText(content, role = 'assistant') {
    this.emit({ role, content })
  }

  emitAndEnd(text) {
    this.scan(text)
    this.flush()
    this.emit({}, 'stop', {})
    this.res.write('data: [DONE]\n\n')
    this.res.end()
  }

  sendFinalChunk() {
    if (this._finished) return
    this._finished = true
    this.flush()
    this.emit({}, 'stop', this.tokenUsage)
    this.res.write('data: [DONE]\n\n')
    this.res.end()
    this.session.lastUsed = new Date().toISOString()
    if (this.onFinalChunk) this.onFinalChunk()
  }

  // ── file upload ────────────────────────────────────────────────────────

  async _uploadFile(uploadFn, file, collector) {
    this.emitText(`\nUploading image...`)
    const result = await uploadFn(file)
    this.emitText(' done.\n')
    collector.push(result)
    return result
  }

  // ── pipeline setup ─────────────────────────────────────────────────────

  /**
   * Shared pipeline: restore MCP injections, format prompt, build prompt,
   * show available MCP tags on new sessions, and handle skills.
   * Returns { prompt } — if a skill was triggered the response is already
   * ended by handleSkill and the caller should return early.
   *
   * When this.rawMode is set (ephemeral/non-real-session calls), all of the
   * above is skipped entirely — no instructions injection, no skill
   * matching, no MCP tag scanning. Just a flat role-tagged prompt built
   * straight from the raw messages.
   *
   * @param {Array}  messages
   * @param {Array}  tools
   * @param {object} req
   * @returns {Promise<{prompt: string, handled: boolean}>}
   */
  async setup(messages, tools, req) {
    if (this.ephemeralMode) {
      console.warn('[SERVER] EPHEMERAL CALL')
      const { prompt } = await this.compiler.uploadAndFormatPromptForRaw(messages, this, false)
      return { prompt, handled: false }
    }

    if (this.rawMode) {
      const { prompt } = await this.compiler.uploadAndFormatPromptForRaw(messages, this, true)
      return { prompt, handled: false }
    }

    registerAutoMcpServers(tools, this.session)
    restoreMcpInjections(this.session, this.compiler.tools, tools)

    const { prompt, skill } = await this.compiler.uploadAndFormatPrompt(messages, this)

    if (skill) {
      handleSkill(skill, req, this)
      return { prompt: '', handled: true }
    }

    if (this.isNewSession) showAvailableMcpTags(tools, this)

    const built = this.compiler.buildPrompt(prompt, this)

    return { prompt: built, handled: false }
  }

  // ── error handling ─────────────────────────────────────────────────────

  /**
   * Emit an error through the stream in OpenAI-compatible format.
   * @param {Error} error
   */
  onError(error, ctx = {}) {
    const source = ctx.source || 'route'
    const responseClosed = this._finished
    const contentComplete = !!ctx.finished
    const detail = ctx.detail || error?.message || String(error)

    const reason = responseClosed
      ? `post-finalization ${source} error — ${detail}`
      : contentComplete
        ? `post-completion ${source} error — ${detail}`
        : `${source} error — ${detail}`

    routeErrorLog.log({
      ts: new Date().toISOString(),
      provider: this.provider,
      reason,
      chatSessionId: this.session?.chatSessionId,
      parentMessageId: this.session?.parentMessageId,
      model: this.session?.model,
      lastEventType: ctx.lastEventType,
      dataCount: ctx.dataCount,
      producedOutput: ctx.producedOutput,
      currentFragmentType: ctx.currentFragmentType,
      hasSentReasoningRole: ctx.hasSentReasoningRole,
      responseId: ctx.responseId,
      error: serializeError(error),
    })

    if (responseClosed || contentComplete) return

    this._finished = true
    console.error(`[${this.provider}] ${source} error:\n`, error.message)
    const err = toOpenAIError(error, this.provider)
    this.emitAndEnd(`\n\n⚠ ${err.error.message}${err.error.action ? ' ' + err.error.action : ''}\n`)
  }

  // ── block scanning ───────────────────────────────────────────────────────

  scan(text) {
    if (this.rawMode) {
      this.emitText(text)
      return
    }

    this.buffer += text

    while (true) {
      if (this.inTool) {
        const closeIdx = SYNTAX.findClose(this.buffer)
        if (closeIdx === -1) return

        const payload = this.buffer.slice(1, closeIdx)
        this.buffer = this.buffer.slice(closeIdx + 1)

        this.inTool = false
        this.toolStartFound = false

        this.toolBuffers.push(payload)
        continue
      }

      if (this.toolStartFound) {
        const pipeIdx = this.buffer.indexOf(SYNTAX.SEP)
        if (pipeIdx === -1) {
          if (this.buffer.length <= this._maxToolLen) return
          this.emitText(this.buffer)
          this.buffer = ''
          this.toolStartFound = false
          return
        }

        const tool = this.buffer.slice(1, pipeIdx)
        if (this.toolIndex[tool]) {
          console.debug('[TOOL]', tool)
          this.inTool = true
          continue
        }

        this.emitText(this.buffer.slice(0, pipeIdx + 1))
        this.buffer = this.buffer.slice(pipeIdx + 1)
        this.toolStartFound = false
        continue
      }

      const startIdx = this.buffer.indexOf(SYNTAX.OPEN)
      if (startIdx === -1) {
        if (this.buffer) this.lastChar = this.buffer[this.buffer.length - 1]
        this.emitText(this.buffer)
        this.buffer = ''
        return
      }

      const charBefore = startIdx > 0 ? this.buffer[startIdx - 1] : this.lastChar
      if (charBefore === '`') {
        this.emitText(this.buffer.slice(0, startIdx + 1))
        this.lastChar = SYNTAX.OPEN
        this.buffer = this.buffer.slice(startIdx + 1)
        continue
      }

      this.emitText(this.buffer.slice(0, startIdx))
      if (startIdx > 0) this.lastChar = this.buffer[startIdx - 1]
      this.buffer = this.buffer.slice(startIdx)
      this.toolStartFound = true
    }
  }

  flush() {
    if (this.inTool) this.scan(SYNTAX.CLOSE)

    emitToolCalls(this.compiler, this.session, this.toolBuffers, this.emit)

    if (!this.toolStartFound || !this.buffer) return

    this.emitText(this.buffer)
    this.buffer = ''
    this.toolStartFound = false
  }
}

module.exports = { StreamPipeline }
