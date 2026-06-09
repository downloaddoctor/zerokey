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

function emitToolCalls(compiler, session, payloads, emit) {
  const tool_calls = payloads
    .flatMap((payload) => {
      const func = compiler.compile(payload, session)
      if (!func) return []
      return Array.isArray(func) ? func : [func]
    })
    .map((f, i) => buildCall(i, f.tool, f.name, f.arguments))
    .filter(Boolean)

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
    this.name = null
    this.buffer = ''
    this.toolBuffers = []
    this.compiler = compiler
    this.toolIndex = compiler.tools
    this.session = session

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
  }

  scan(text) {
    const len = this.buffer.length
    this.buffer += text

    if (this.inTool) {
      // ── Inside tool: scan for closing ⟧ ──
      const closeIdx = text.indexOf('⟧')
      if (closeIdx === -1) return

      const endIdx = len + closeIdx
      const payload = this.buffer.slice(0, endIdx)
      const leftover = this.buffer.slice(endIdx + 1)
      this.toolBuffers.push(payload)
      this.inTool = false
      this.toolStartFound = false
      this.name = null
      this.buffer = ''

      this.scan(leftover)
      return
    }

    if (this.toolStartFound) {
      const closeIdx = text.indexOf('¦')
      if (closeIdx === -1) {
        // Partial marker — wait for more data
        if (len > 21) {
          this.toolStartFound = false
        }
      } else {
        const pipeIdx = len + closeIdx
        const tool = this.buffer.slice(0, pipeIdx)
        console.log('[TOOL]', tool)
        if (this.toolIndex[tool]) {
          this.inTool = true
          this.name = tool
          const leftover = this.buffer.slice(pipeIdx + 1)
          this.buffer = this.buffer.slice(0, pipeIdx + 1) // tool + ¦
          this.scan(leftover)
          return
        }
      }

      if (!this.toolStartFound) {
        this.emit({ role: 'assistant', content: `⟦${this.buffer}` })
        this.buffer = ''
      }
      return
    }

    // ── Outside tool: scan for opening first ──
    const startIdx = text.indexOf('⟦')
    if (startIdx === -1) {
      // No tool incoming — safe to strip any stray closing brackets
      const closeIdx = text.indexOf('⟧')
      if (closeIdx !== -1) {
        this.buffer = this.buffer.replaceAll('⟧', '')
      }
      this.emit({ role: 'assistant', content: this.buffer })
      this.buffer = ''
      return
    }

    const toolStartIdx = len + startIdx
    this.toolStartFound = true
    this.emit({ role: 'assistant', content: this.buffer.slice(0, toolStartIdx) })
    const leftover = this.buffer.slice(toolStartIdx + 1)
    this.buffer = ''
    this.scan(leftover)
  }

  flush() {
    if (this.inTool) this.scan('⟧')

    emitToolCalls(this.compiler, this.session, this.toolBuffers, this.emit)

    if (!this.toolStartFound) return

    // Stream ended mid tool-name — emit as plain text
    this.emit({ role: 'assistant', content: `⟦${this.buffer}` })
    this.buffer = ''
    this.toolStartFound = false
  }
}

module.exports = { Stream }
