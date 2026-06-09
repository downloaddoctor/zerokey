const fs = require('fs')
const path = require('path')

const { getIDEMapper, TOOL_OUTPUT_LIMITS } = require('./tool-defs')
const { Stream } = require('./stream')

class ToolCompiler {
  static objects = {}

  /**
   * @param {string} ideName - Target IDE name (e.g., 'vscode', 'jetbrains')
   */
  constructor(ideName, provider = 'chatgpt') {
    const cacheKey = ideName + ':' + provider
    if (ToolCompiler.objects[cacheKey]) {
      return ToolCompiler.objects[cacheKey]
    }

    this.ideName = ideName
    this.provider = provider

    const { tools, user, tool, reverseMap } = getIDEMapper(ideName)

    function getGenericToolName(id) {
      const name = id.slice(10)
      return reverseMap[name] || name
    }

    const limit = TOOL_OUTPUT_LIMITS[provider] ?? 64_000
    const truncate =
      limit === Infinity
        ? (s) => s
        : (s) =>
            typeof s === 'string' && s.length > limit
              ? s.slice(0, limit - 128) + `\n[TRUNCATED: output exceeded ${limit} chars]`
              : s

    this.tools = tools
    this._handlers = {
      system: (c) => `SYSTEM: ${c}`,
      assistant: (c) => `ASSISTANT: ${c}`,
      user: (c, messages, isNewSession) => user('USER: ', c, messages, isNewSession),
      tool: (c, messages) => {
        // require('fs').writeFile('temp/mes.json', JSON.stringify(messages, null, 1), () => {})

        const toolResults = []
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (m.role !== 'tool') break
          toolResults.unshift(m)
        }

        return toolResults
          .map((m) => `TOOL(${getGenericToolName(m.tool_call_id)}): ${truncate(tool(m.content))}`)
          .join('\n')
      },
    }

    ToolCompiler.objects[cacheKey] = this
  }

  formatPrompt(messages, isNewSession) {
    console.log('[MESSAGES]', messages.length)
    const message = messages[messages.length - 1]

    const { role, content } = message
    const handler = this._handlers[role]
    return handler ? handler(content, messages, isNewSession) : `${role.toUpperCase()}: ${content}`
  }

  buildPrompt(userPrompt) {
    const loc = path.join(__dirname, 'instructions.md')
    const instructions = fs.readFileSync(loc, 'utf8')
    return `${instructions}\n\n${userPrompt}`
  }

  /**
   * Process LLM output string into IDE-specific format
   * @param {string} compactStr - Compact string from LLM
   * @returns {Object} IDE-specific tool call
   */
  compile(compactStr, session) {
    const internal = this.parse(compactStr)
    return this.emit(internal, session)
  }

  /**
   * Parse compact string format into internal JSON structure
   * @param {string} compactStr - Compact string format: "tool¦key=value¦key=value"
   * @returns {Object} Internal representation { tool, params }
   */
  parse(compactStr) {
    console.log('[TOOL]', compactStr)
    const parts = compactStr.split('¦').filter((e) => e)
    const toolName = parts[0]
    const params = {}

    // Get valid parameter keys for this tool
    const toolDef = this.tools[toolName]

    // Collect key-value pairs
    const pairs = []
    for (let i = 1; i < parts.length; i++) {
      const equalIdx = parts[i].indexOf('=')

      if (equalIdx > -1) {
        const key = parts[i].substring(0, equalIdx)

        if (toolDef.keys[key]) {
          const value = parts[i].substring(equalIdx + 1)
          pairs.push({ key, value: this.inferType(value) })
          continue
        }
      }

      // No '=' — this segment is a continuation
      if (pairs.length) {
        pairs[pairs.length - 1].value += `¦${parts[i]}`
      }
    }

    // Get Repeating Tool format
    const repeatableKeys = toolDef.repeatable

    if (repeatableKeys) {
      // Handle repeating pattern
      const groups = []

      // Determine the anchor key: the first key listed in repeatableKeys
      // For multi_edit: 'path' starts a new group; for todo: 'id' starts a new group
      const anchorKey = Object.keys(repeatableKeys)[0]
      let current = null

      for (const pair of pairs) {
        if (!repeatableKeys[pair.key]) continue
        if (pair.key === anchorKey) {
          current = {}
          groups.push(current)
        }
        if (current) current[pair.key] = pair.value
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
   * Merge delta items into session.todos and return full list.
   */
  _mergeTodo(toolName, deltaItems, session) {
    if (!session.todos) session.todos = {}

    for (const item of deltaItems) {
      if (item.id === undefined) continue
      if (toolName === 'todo' && !session.todos[item.id]) {
        console.warn('[TODO] Invalid todo id:', item)
        continue
      }
      session.todos[item.id] = Object.assign({}, session.todos[item.id] || {}, item)
    }

    return Object.values(session.todos)
  }

  /**
   * Convert internal JSON to IDE-specific format
   * @param {Object} internalJson - Internal representation { tool, params }
   * @returns {Object} IDE-specific tool call
   */
  emit(internal, session) {
    const toolMapping = this.tools[internal.tool]
    if (!toolMapping) {
      throw new Error(`Unknown tool: ${internal.tool} for IDE: ${this.ideName}`)
    }

    toolMapping.transformer(internal.params)

    // For todoAdd / todo: merge delta into persistent state, emit full merged list
    if (internal.tool === 'todoAdd' || internal.tool === 'todo') {
      const delta = internal.params.$array || []
      internal.params.$array = this._mergeTodo(internal.tool, delta, session)
    }

    // terax multi_edit split: one call per edit entry
    if (toolMapping.split && toolMapping.array) {
      const arrayData = internal.params.$array || []
      return arrayData
        .filter((item) => item && Object.keys(item).length > 0)
        .map((item) => {
          const args = Object.assign({}, toolMapping.default)
          for (const [genericField, ideField] of Object.entries(toolMapping.array.fields)) {
            if (item[genericField] !== undefined) {
              args[ideField] = item[genericField]
            }
          }
          return {
            tool: internal.tool,
            name: toolMapping.tool,
            arguments: args,
          }
        })
    }

    const result = {
      tool: internal.tool,
      name: toolMapping.tool,
      arguments: {},
    }

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
