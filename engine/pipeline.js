'use strict'

const SYNTAX = require('./syntax')
const ToolCompiler = require('./compiler')
const { toOpenAIError } = require('../utils/errors')
const { createWriter } = require('../utils/sse-writer')

const {
  restoreMcpInjections,
  showAvailableMcpTags,
  handleSkill,
  registerAutoMcpServers,
} = require('./triggers')
const { ephemeralSession } = require('../utils/ephemeral-session')
const { buildUsage, accumulate } = require('./usage')
const { inspectBatch, MAX_BATCH } = require('./loop-guard')

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

  constructor(res, session, provider, ideName, isReal = true) {
    this.compiler = new ToolCompiler(ideName, provider)

    this.res = res
    this.provider = provider
    this.session = isReal ? session : ephemeralSession(session)

    this.isNewSession = this.session.parentId == null
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

    // SSE writer with backpressure. Every chunk leaves through writer.text /
    // writer.reasoning / writer.toolCalls / writer.finish. The [DONE] frame is
    // written by writer.finish itself.
    const writerModel = this.compiler.provider || provider || 'unknown'
    this.writer = createWriter(res, { model: writerModel })

    this.emit = (delta, finishReason = null, usage = null) => {
      if (delta && delta.reasoning_content !== undefined) {
        this.writer.reasoning(delta.reasoning_content)
        return
      }
      if (delta && Array.isArray(delta.tool_calls)) {
        this.writer.toolCalls(delta.tool_calls)
        if (finishReason === 'stop' && usage != null) {
          this.writer.finish('stop', usage)
        }
        return
      }
      if (delta && typeof delta.content === 'string' && delta.content !== '') {
        this.writer.text(delta.content)
        if (finishReason === 'stop' && usage != null) {
          this.writer.finish('stop', usage)
        }
        return
      }
      // Stop-only frame (empty content, empty tool_calls) — the pipeline is
      // finishing. Hand off to writer.finish with the usage payload.
      if (finishReason === 'stop') {
        this.writer.finish(finishReason || 'stop', usage)
      }
    }

    this.tokenUsage = {}
    this._modelChars = 0
    this._finished = false
    // Accumulated assistant text for the internal MHI tool loop. Appended in
    // emitText; reset by beginTurn(). Never sent to the client directly — the
    // pipeline streams as it scans.
    this.assistantText = ''

    // bindUploader curries the API's uploadFile — must be set per-request.
    this.bindUploader = (api, collector) => {
      this.upload = (file) => this._uploadFile(api.uploadFile.bind(api), file, collector)
    }
  }

  upload(_file) {}

  // ── public emit methods ────────────────────────────────────────────────
  emit(delta, _finishReason = null, _usage = null) {}

  emitText(content, role = 'assistant') {
    if (typeof content === 'string') this.assistantText += content
    this.emit({ role, content })
  }

  /**
   * Reset per-turn state before another upstream round of the tool loop.
   * Emitted frames still go out; only the accumulated assistant text resets,
   * so the loop can tell what this turn produced.
   */
  beginTurn() {
    this.assistantText = ''
    this.tokenUsage = {}
    this._modelChars = 0
  }

  /**
   * Raw chunk writer used by provider stream handlers (e.g. Qwen) that emit
   * their own OpenAI-shaped deltas. Runs through the writer's backpressure
   * path; a chunk carrying a `finish_reason` closes the stream.
   */
  writeChunk(chunk) {
    if (!chunk || !Array.isArray(chunk.choices) || chunk.choices.length === 0) return
    const delta = chunk.choices[0].delta || {}
    const finishReason = chunk.choices[0].finish_reason
    if (delta.reasoning_content !== undefined) {
      this.writer.reasoning(delta.reasoning_content)
    } else if (Array.isArray(delta.tool_calls)) {
      this.writer.toolCalls(delta.tool_calls)
    } else if (typeof delta.content === 'string' && delta.content !== '') {
      this.writer.text(delta.content)
    } else if (delta.role === 'assistant' && !delta.content) {
      // Role-only frame — writer.text emits the role implicitly on first text.
    }
    if (finishReason === 'stop' || finishReason === 'length') {
      const turnUsage = buildUsage(this.tokenUsage, this.compiler.lastPrompt, this._modelChars)
      const totals = accumulate(this.session, turnUsage)
      this.session.lastTokenUsage = turnUsage.total_tokens || 0
      this.writer.finish(finishReason, { ...turnUsage, session: totals })
      this._finished = true
      this.session.lastUsed = new Date().toISOString()
      if (this.onFinalChunk) this.onFinalChunk()
    }
  }

  emitAndEnd(text) {
    this.scan(text)
    this.flush()
    const turnUsage = buildUsage(this.tokenUsage, this.compiler.lastPrompt, this._modelChars)
    const totals = accumulate(this.session, turnUsage)
    this.session.lastTokenUsage = turnUsage.total_tokens || 0
    this.writer.finish('stop', { ...turnUsage, session: totals })
    this._finished = true
    this.session.lastUsed = new Date().toISOString()
    if (this.onFinalChunk) this.onFinalChunk()
  }

  sendFinalChunk() {
    if (this._finished) return
    // During an internal MHI tool loop, each upstream turn finishes its stream
    // but the client must NOT see a finish until the loop resolves. deferFinish
    // suppresses the writer.finish call; the router calls flushFinish() once at
    // the end. onFinalChunk still fires per turn so the router can await the
    // current upstream stream before reading pipeline.assistantText.
    if (this.deferFinish) {
      this._turnFinished = true
      if (this.onFinalChunk) {
        try {
          this.onFinalChunk()
        } catch (caughtErr) {
          console.error('this.onFinalChunk() failed:', caughtErr)
        }
      }
      return
    }
    this._finished = true
    this.flush()
    // Real provider numbers win; estimate is the fallback. See engine/usage.js.
    const turnUsage = buildUsage(this.tokenUsage, this.compiler.lastPrompt, this._modelChars)
    const totals = accumulate(this.session, turnUsage)
    this.session.lastTokenUsage = turnUsage.total_tokens || 0
    this.writer.finish('stop', { ...turnUsage, session: totals })
    this.session.lastUsed = new Date().toISOString()
    if (this.onFinalChunk) this.onFinalChunk()
  }

  /**
   * Send the closing SSE frame after a deferred tool loop. Call exactly once
   * when the loop resolves; harmless if called again.
   */
  flushFinish() {
    if (this._finished) return
    this.deferFinish = false
    this._finished = true
    this.flush()
    const turnUsage = buildUsage(this.tokenUsage, this.compiler.lastPrompt, this._modelChars)
    const totals = accumulate(this.session, turnUsage)
    this.session.lastTokenUsage = turnUsage.total_tokens || 0
    this.writer.finish('stop', { ...turnUsage, session: totals })
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
    restoreMcpInjections(
      this.session,
      this.compiler.tools,
      tools,
      this.compiler.surfaceDef?.browserNameMap,
    )

    const reinjectEvery = this.compiler.reinjectEvery || 0
    if (reinjectEvery > 0) {
      this.session.turnCount = (this.session.turnCount || 0) + 1
      if (this.session.turnCount > 1 && this.session.turnCount % reinjectEvery === 0) {
        const { content } = require('./instructions').getExtra('reminder')
        messages.push({
          role: 'live_instructions',
          content: content,
        })
        console.debug(`[REINJECT] turn ${this.session.turnCount} — instructions re-injected`)
      }
    }

    // Token-threshold reinjection. Providers declare `reinjectAt` as a list of
    // { tokens, fragment } — every time accumulated completion tokens cross
    // tokens*n for some positive integer n, the fragment is re-injected. This
    // complements reinjectEvery (turn-based) for long single-turn generations.
    const reinjectAt = this.compiler.reinjectAt
    if (Array.isArray(reinjectAt) && reinjectAt.length) {
      const used = this.session.lastTokenUsage || 0
      if (used > 0) {
        for (const rule of reinjectAt) {
          if (!rule || !Number.isFinite(rule.tokens) || rule.tokens <= 0) continue
          const step = Math.floor(used / rule.tokens)
          const seenKey = `_reinjectStep_${rule.fragment}`
          const prev = this.session[seenKey] || 0
          if (step > prev && step > 0) {
            this.session[seenKey] = step
            const { content } = require('./instructions').getExtra(rule.fragment)
            messages.push({ role: 'live_instructions', content })
            console.debug(
              `[REINJECT] tokens ${used} crossed ${rule.tokens}*${step} — $${rule.fragment} injected`,
            )
          }
        }
      }
    }

    if (this.session._driftWarning) {
      this.session._driftWarning = false
      messages.push({
        role: 'live_instructions',
        content:
          'Your previous response emitted duplicate or too many tool calls. Those results are already in the conversation. Do not repeat them. Take the single next unfinished step of the task.',
      })
      console.debug('[LOOP] drift reminder injected')
    }

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

    // Structured block goes to zerokey.log; console mirrors the same shape.
    console.error(`[${this.provider.toUpperCase()}] ${reason}`, error, {
      chatSessionId: this.session?.chatSessionId,
      parentMessageId: this.session?.parentMessageId,
      model: this.session?.model,
      lastEventType: ctx.lastEventType,
      dataCount: ctx.dataCount,
      producedOutput: ctx.producedOutput,
      currentFragmentType: ctx.currentFragmentType,
      hasSentReasoningRole: ctx.hasSentReasoningRole,
      responseId: ctx.responseId,
    })

    if (responseClosed || contentComplete) return

    this._finished = true
    const err = toOpenAIError(error, this.provider)
    this.emitAndEnd(`\n\n⚠ ${err.error.message}${err.error.action ? ' ' + err.error.action : ''}\n`)
  }

  // ── block scanning ───────────────────────────────────────────────────────

  scan(text) {
    this._modelChars += text ? text.length : 0
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

    const { deduped, selfDuplicates, oversized, drifting } = inspectBatch(this.toolBuffers)

    if (selfDuplicates) {
      console.warn(`[LOOP] dropped ${selfDuplicates} self-duplicate(s) in one response`)
    }
    if (oversized) {
      console.warn(`[LOOP] oversized batch: ${deduped.length} calls (cap ${MAX_BATCH})`)
    }
    if (drifting) {
      this.session._driftWarning = true
    }

    emitToolCalls(this.compiler, this.session, deduped, this.emit)

    if (!this.toolStartFound || !this.buffer) return

    this.emitText(this.buffer)
    this.buffer = ''
    this.toolStartFound = false
  }
}

module.exports = { StreamPipeline }
