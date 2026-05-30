let callCounter = 0

function buildCall(index, tool, funcName, args) {
  callCounter++

  return {
    index,
    id: 'call_' + String(callCounter).padStart(4, '0') + '_' + tool,
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

const chunkMid = ',"finish_reason":'
const chunkSuffix = '}]}\n\n'
const chunkUsage = ',"usage":'

class Stream {
  constructor(res, model, compiler) {
    this.inTool = false
    this.toolStartFound = false
    this.name = null
    this.buffer = ''
    this.compiler = compiler
    this.toolIndex = compiler.tools
    this.toolBuffers = []

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

      // Tool complete: save payload
      const endIdx = len + closeIdx
      const payload = this.buffer.slice(0, endIdx)
      this.toolBuffers.push(payload)
      this.inTool = false
      this.toolStartFound = false
      this.name = null
      this.buffer = this.buffer.slice(endIdx + 1)
      this.scan('')
      return
    }

    if (this.toolStartFound) {
      const closeIdx = text.indexOf('¦')
      if (closeIdx === -1) {
        // Partial marker — wait for more data
        if (len > 12) {
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
        this.emit({ role: 'assistant', content: '⟦' + this.buffer })
        this.buffer = ''
      }
      return
    }

    // ── Outside tool: scan for opening ⟦ ──
    const startIdx = text.indexOf('⟦')
    if (startIdx === -1) {
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
    // Drain any incomplete tool still buffered (stream ended without ⟧)
    if (this.inTool) {
      const idx = this.buffer.lastIndexOf('⟧')

      this.toolBuffers.push(idx === -1 ? this.buffer : this.buffer.slice(0, idx))
    } else if (this.toolStartFound) {
      // Stream ended mid tool-name — emit as plain text
      this.emit({ role: 'assistant', content: '⟦' + this.buffer })
      this.buffer = ''
      this.toolStartFound = false
    }

    const tool_calls = this.toolBuffers
      .flatMap((payload) => {
        const func = this.compiler.compile(payload)
        if (!func) return []
        return Array.isArray(func) ? func : [func]
      })
      .map((func, i) => buildCall(i, func.tool, func.name, func.arguments))
      .filter((e) => e)

    if (!tool_calls.length) return

    const delta = buildToolDelta(tool_calls)
    console.log('[RES]', delta.tool_calls)
    this.emit(delta)
    this.toolBuffers = []
  }
}

module.exports = { Stream }
