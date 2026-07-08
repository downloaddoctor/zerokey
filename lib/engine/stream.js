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
  let lastTodoFunc = null

  const tool_calls = payloads
    .flatMap((payload) => {
      const func = compiler.compile(payload, session)
      if (!func) return []
      return Array.isArray(func) ? func : [func]
    })
    .filter((f) => {
      if (TODO_TOOLS.has(f.tool)) {
        lastTodoFunc = f
        return false
      }
      return true
    })
    .map((f, i) => buildCall(i, f.tool, f.name, f.arguments))
    .filter(Boolean)

  if (lastTodoFunc) {
    tool_calls.push(
      buildCall(tool_calls.length, lastTodoFunc.tool, lastTodoFunc.name, lastTodoFunc.arguments),
    )
  }

  if (!tool_calls.length) return

  const delta = buildToolDelta(tool_calls)
  console.log('[TOOL] EMIT', delta.tool_calls)
  emit(delta)
}

const chunkMid = ',"finish_reason":'
const chunkSuffix = '}]}\n\n'
const chunkUsage = ',"usage":'

class Stream {
  constructor(res, model, compiler, session) {
    this.inTool = false
    this.toolStartFound = false
    this.buffer = ''
    this.toolBuffers = []
    this.compiler = compiler
    this.toolIndex = compiler.tools
    this.session = session
    this._maxToolLen = Math.max(...Object.keys(compiler.tools).map((k) => k.length)) + 3

    const completionId = `chatcmpl-${Date.now()}${Math.random().toString(36).slice(2, 8)}`
    const created = Math.floor(Date.now() / 1000)
    const chunkPrefix = `data: {"id":"${completionId}","object":"chat.completion.chunk","created":${created},"model":"${model}","choices":[{"index":0,"delta":`

    this.emit = (delta, finishReason = null, usage = null) => {
      const parts = [chunkPrefix, JSON.stringify(delta), chunkMid, JSON.stringify(finishReason)]
      if (usage != null) {
        parts.push(chunkUsage, JSON.stringify(usage))
      }
      parts.push(chunkSuffix)
      res.write(parts.join(''))
    }

    this.emitText = (content, role = 'assistant') => this.emit({ role, content })
  }

  scan(text) {
    this.buffer += text

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // STATE: inside tool body, scanning for close bracket
      if (this.inTool) {
        const closeIdx = this.buffer.indexOf('⟧')
        if (closeIdx === -1) return
        this.toolBuffers.push(this.buffer.slice(1, closeIdx))
        this.buffer = this.buffer.slice(closeIdx + 1)
        this.inTool = false
        this.toolStartFound = false
        continue
      }

      // STATE: saw open bracket, buffering potential tool name
      if (this.toolStartFound) {
        const pipeIdx = this.buffer.indexOf('¦')
        if (pipeIdx === -1) {
          if (this.buffer.length <= this._maxToolLen) return
          // Too long — not a valid tool name
          this.emitText(this.buffer)
          this.buffer = ''
          this.toolStartFound = false
          return
        }

        const tool = this.buffer.slice(1, pipeIdx)
        if (this.toolIndex[tool]) {
          console.log('[TOOL]', tool)
          this.inTool = true
          continue
        }

        // Not a tool — emit open bracket + name + pipe as plain text, keep scanning
        this.emitText(this.buffer.slice(0, pipeIdx + 1))
        this.buffer = this.buffer.slice(pipeIdx + 1)
        this.toolStartFound = false
        continue
      }

      // STATE: normal text, scanning for open bracket
      const startIdx = this.buffer.indexOf('⟦')
      if (startIdx === -1) {
        this.emitText(this.buffer)
        this.buffer = ''
        return
      }

      this.emitText(this.buffer.slice(0, startIdx))
      this.buffer = this.buffer.slice(startIdx)
      this.toolStartFound = true
    }
  }

  flush() {
    if (this.inTool) this.scan('⟧')

    emitToolCalls(this.compiler, this.session, this.toolBuffers, this.emit)

    if (!this.toolStartFound || !this.buffer) return

    // Stream ended mid tool-name — emit as plain text
    this.emitText(this.buffer)
    this.buffer = ''
    this.toolStartFound = false
  }
}

module.exports = { Stream }
