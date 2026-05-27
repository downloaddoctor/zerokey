const fs = require('fs')
const path = require('path')

const { getIDEMapper } = require('./tool-defs')
const { Stream } = require('./stream')

class ToolCompiler {
  static objects = {}

  /**
   * @param {string} ideName - Target IDE name (e.g., 'vscode', 'jetbrains')
   */
  constructor(ideName) {
    if (ToolCompiler.objects[ideName]) {
      return ToolCompiler.objects[ideName]
    }

    this.ideName = ideName

    const { tools, prompt, user, tool, reverseMap } = getIDEMapper(ideName)

    this.prompt = prompt
    this.tools = tools
    this._handlers = {
      system: (c) => 'SYSTEM: ' + c,
      user: (c, messages) => user('USER: ', c, messages),
      assistant: (c) => 'ASSISTANT: ' + c,
      tool: (c, messages, id) => {
        const name = id.slice(10)
        return `TOOL(${reverseMap[name] || name}): ` + tool(c)
      },
    }

    ToolCompiler.objects[ideName] = this
  }

  formatPrompt(messages) {
    console.log('[MESSAGES]', messages.length)
    const message = messages[messages.length - 1]

    const { role, content, tool_call_id } = message
    const handler = this._handlers[role]
    return handler ? handler(content, messages, tool_call_id) : role.toUpperCase() + ': ' + content
  }

  buildPrompt(userPrompt) {
    const loc = path.join(__dirname, 'prompt.md')
    const basePrompt = fs.readFileSync(loc, 'utf8')
    return basePrompt + this.prompt + '\n' + userPrompt
  }

  /**
   * Process LLM output string into IDE-specific format
   * @param {string} compactStr - Compact string from LLM
   * @returns {Object} IDE-specific tool call
   */
  compile(input) {
    const internal = this.parse(input)
    return this.emit(internal)
  }

  /**
   * Parse compact string format into internal JSON structure
   * @param {string} compactStr - Compact string format: "tool¦key=value¦key=value"
   * @returns {Object} Internal representation { tool, params }
   */
  parse(input) {
    console.log('[TOOL]', input)
    const parts = input.split('¦')
    const toolName = parts[0]
    const params = {}

    // Get valid parameter keys for this tool
    const toolDef = this.tools[toolName]

    // Collect key-value pairs
    const pairs = []
    for (let i = 1; i < parts.length; i++) {
      const equalIdx = parts[i].indexOf('=')

      if (equalIdx === -1) {
        // No '=' — this segment is a path continuation (e.g. C:/foo/bar split on /)
        if (pairs.length) {
          pairs[pairs.length - 1].value += '¦' + parts[i]
        }
        continue
      }

      const key = parts[i].substring(0, equalIdx)
      const value = parts[i].substring(equalIdx + 1)

      if (toolDef.keys[key] || (toolDef.keysRegex && toolDef.keysRegex.test(key))) {
        pairs.push({ key, value: this.inferType(value) })
      } else if (pairs.length) {
        // Unknown key — treat as continuation of previous value (path fragments, etc.)
        pairs[pairs.length - 1].value += '¦' + parts[i]
      }
    }

    // Get Repeating Tool format
    const repeatableKeys = toolDef.repeatable

    if (repeatableKeys) {
      // Handle repeating pattern
      const groups = []
      const indices = {}

      for (const field in repeatableKeys) {
        indices[field] = 0
      }

      for (const pair of pairs) {
        if (repeatableKeys[pair.key]) {
          const idx = indices[pair.key]
          if (!groups[idx]) groups[idx] = {}
          groups[idx][pair.key] = pair.value
          indices[pair.key]++
        }
      }

      // Get non-repeating fields (like path for edit)
      for (const pair of pairs) {
        if (!repeatableKeys[pair.key]) {
          params[pair.key] = pair.value
        }
      }

      params.$array = groups.filter((g) => g && Object.keys(g).length > 0)
    } else {
      for (const pair of pairs) params[pair.key] = pair.value
    }

    return { tool: toolName, params }
  }

  /**
   * Convert internal JSON to IDE-specific format
   * @param {Object} internalJson - Internal representation { tool, params }
   * @returns {Object} IDE-specific tool call
   */
  emit(internal) {
    const toolMapping = this.tools[internal.tool]
    if (!toolMapping) {
      throw new Error(`Unknown tool: ${internal.tool} for IDE: ${this.ideName}`)
    }

    const result = {
      tool: internal.tool,
      name: toolMapping.tool,
      arguments: {},
    }

    toolMapping.transformer(internal.params)

    if (toolMapping.default) {
      Object.assign(result.arguments, toolMapping.default)
    }

    // Handle array/repeating fields
    if (toolMapping.array) {
      const arrayData = internal.params.$array || []
      if (Array.isArray(arrayData) && arrayData.length) {
        result.arguments[toolMapping.array.key] = arrayData.map((item) => {
          const mappedItem = {}
          for (const [genericField, ideField] of Object.entries(toolMapping.array.fields)) {
            if (item[genericField] !== undefined) {
              // If ideField is an object (status mapping), use it to translate
              if (typeof ideField === 'object') {
                mappedItem[genericField] = ideField[item[genericField]] || item[genericField]
              } else {
                mappedItem[ideField] = item[genericField]
              }
            }
          }
          return mappedItem
        })
      }
    }

    // Handle simple params
    for (const [genericField, ideField] of Object.entries(toolMapping.params)) {
      if (internal.params[genericField] !== undefined) {
        result.arguments[ideField] = internal.params[genericField]
      }
    }

    toolMapping.transform(result.arguments, internal.params)

    return result
  }

  /**
   * Infer the JavaScript type from a string value
   * @param {string} value - String value to infer type from
   * @returns {*} Inferred typed value
   */
  inferType(value) {
    if (value === 'true') return true
    if (value === 'false') return false
    if (/^-?\d+(?:\.\d+)?$/.test(value)) {
      // integer vs float
      return value.indexOf('.') === -1 ? parseInt(value, 10) : parseFloat(value)
    }
    return value
  }
}

ToolCompiler.Stream = Stream
module.exports = ToolCompiler
