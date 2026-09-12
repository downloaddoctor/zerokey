const instructions = require('./instructions')
const SYNTAX = require('./syntax')
const { getIDEMapper } = require('./tool-defs')
const { PROMPT_LIMITS } = require('../config/constants')
const { matchMcpTrigger } = require('./triggers')
const { decodeContentParts } = require('../utils/extract-files')

class ToolCompiler {
  static objects = {}

  /**
   * @param {string} ideName - Target IDE name (e.g., 'vscode', 'terax', 'opencode')
   * @param {string} provider
   */
  constructor(ideName, provider = 'chatgpt') {
    const cacheKey = ideName + ':' + provider
    if (ToolCompiler.objects[cacheKey]) {
      return ToolCompiler.objects[cacheKey]
    }

    this.ideName = ideName
    this.provider = provider

    const { tools, user, tool, system, rawUser, reverseMap } = getIDEMapper(ideName)
    this._rawUser = rawUser

    this._reverseMap = reverseMap

    function getGenericToolName(id) {
      const name = id.slice(10)
      return reverseMap[name] || name
    }

    this._promptLimit = (PROMPT_LIMITS[provider] ?? 64_000) - 64

    this.tools = tools
    this._handlers = {
      system: (mes) => system(mes.content),
      agent: (mes) => `AGENT: ${mes.content}`,
      assistant: (mes) => `ASSISTANT: ${mes.content}`,
      internal: (mes) => `<internal>\n${mes.content}\n</internal>`,
      user: async (mes, messages, isNewSession) => {
        if (mes.content === '<attachments>') return ''
        if (mes.content.startsWith('<attachment ')) {
          mes.content = '<attachments>' + mes.content
        }

        return user(mes.content, messages, isNewSession)
      },
      tool: async (mes) => {
        const name = getGenericToolName(mes.tool_call_id)
        const output = tool(name, mes.content)

        return `${SYNTAX.NAME}(${name}): ${output}`
      },
    }

    ToolCompiler.objects[cacheKey] = this
  }

  async uploadAndGetMessages(messages, parser, upload = true) {
    console.debug('[MESSAGES]', messages.length)

    let i = messages.length - 1
    for (; i >= 0; i--) if (messages[i].role === 'assistant') break
    i++

    const requestMessages = []
    for (; i < messages.length; i++) {
      const mes = messages[i]
      const files = decodeContentParts(mes.content)
      if (files.length) {
        for (const file of files) {
          if (upload) await parser.upload(file)
        }
        continue
      }

      requestMessages.push(mes)
    }

    return requestMessages
  }

  async uploadAndFormatPrompt(messages, parser) {
    const message = messages[messages.length - 1]

    let skill = null
    if (message?.role === 'user' && this._rawUser) {
      try {
        const raw = this._rawUser(message.content, messages, parser.isNewSession)
        const text = (typeof raw === 'string' ? raw : '').trim().toLowerCase()
        skill = ToolCompiler.matchSkill(text, raw)
        if (skill) {
          console.info('[SKILL]', skill.trigger)
          parser.emitText(`\n**SKILL TRIGGER:** \`${skill.trigger}\`\n`)

          // Passthrough skills (e.g. $browser) don't short-circuit the stream —
          // they register tools into this.tools and inline their grammar into the
          // triggering message, then the request continues to the provider as normal.
          if (skill.passthrough) {
            console.info('[SKILL]', skill.trigger, 'is passthrough!')
            skill.call({ messages, index: messages.length - 1, compilerTools: this.tools, parser })
            skill = null
          }
        }
      } catch (e) {
        console.error('[SKILL] rawUser check failed:', e.message)
      }
    }

    const requestMessages = await this.uploadAndGetMessages(messages, parser)
    const results = []

    for (const mes of requestMessages) {
      const handler = this._handlers[mes.role]
      const result = handler
        ? await handler(mes, messages, parser.isNewSession)
        : `${mes.role.toUpperCase()}: ${mes.content}`

      if (result) results.push(result)
    }

    return { prompt: results.join('\n\n'), skill }
  }

  async uploadAndFormatPromptForRaw(messages, parser, upload = false) {
    const requestMessages = await this.uploadAndGetMessages(messages, parser, upload)
    const results = []

    for (const mes of requestMessages) {
      const content = typeof mes.content === 'string' ? mes.content : JSON.stringify(mes.content)
      results.push(`${mes.role.toUpperCase()}: ${content}`)
    }

    return { prompt: results.join('\n\n') }
  }

  limitPrompt(prompt) {
    const limit = this._promptLimit
    if (prompt.length <= limit) {
      console.debug('[PROMPT] FINAL', {
        chars: prompt.length,
        bytes: Buffer.byteLength(prompt, 'utf8'),
        limit,
        truncated: false,
      })
      return prompt
    }

    console.warn(`[PROMPT] Final prompt exceeded ${limit} chars: ${prompt.length}`)

    const truncated =
      prompt.slice(0, limit - 64) +
      '\n\n[TRUNCATED: final prompt exceeded the provider prompt limit]'

    console.debug('[PROMPT] FINAL', {
      chars: truncated.length,
      bytes: Buffer.byteLength(truncated, 'utf8'),
      limit,
      truncated: true,
    })

    return truncated
  }

  buildPrompt(userPrompt, parser) {
    let finalPrompt = userPrompt

    if (parser.isNewSession && !parser.haveInstructionsAPI && parser.toolCalling) {
      const { content } = instructions.getFull()
      finalPrompt = `${content}\n\n${userPrompt}`
    }

    return this.limitPrompt(finalPrompt)
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
    console.debug('[TOOL]', compactStr)
    const parts = compactStr.split('¦').filter((e) => e)
    const toolName = parts[0]
    const params = {}

    // Get valid parameter keys for this tool
    const toolDef = this.tools[toolName]

    if (!toolDef) {
      throw new Error(`Unknown tool: ${toolName} for IDE: ${this.ideName}`)
    }

    // Dynamic MCP tool — strict key filtering against schema
    if (toolDef && toolDef._passthrough) {
      const validKeys = toolDef._validKeys
      const dropped = []
      for (let i = 1; i < parts.length; i++) {
        const equalIdx = parts[i].indexOf('=')
        if (equalIdx > -1) {
          const key = parts[i].substring(0, equalIdx)
          if (validKeys.size === 0 || validKeys.has(key)) {
            params[key] = this.inferType(parts[i].substring(equalIdx + 1))
          } else {
            dropped.push(key)
          }
        }
      }
      if (dropped.length) {
        console.warn('[DynamicTool] dropped unknown keys:', dropped.join(', '))
      }
      return { tool: toolName, params, _passthrough: true }
    }

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
      if (toolName === 'todos_set' && !session.todos[item.id]) {
        console.warn('[TODO] Invalid todo id:', item)
        continue
      }
      session.todos[item.id] = Object.assign({}, session.todos[item.id] || {}, item)
    }

    const all = Object.values(session.todos)
    const allDone = all.length > 0 && all.every((t) => t.status === 'done')
    if (allDone) {
      console.info('[TODO] All tasks complete — clearing list')
      session.todos = {}
      return []
    }

    return all
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

    // MCP passthrough tools have no generic->IDE field mapping (schema keys
    // already ARE the real argument names), so forward params as-is.
    if (toolMapping._passthrough) {
      return {
        tool: internal.tool,
        name: toolMapping.tool,
        arguments: { ...internal.params },
      }
    }

    toolMapping.transformer(internal.params)

    // For todoAdd / todo: merge delta into persistent state, emit full merged list
    if (internal.tool === 'todos_add' || internal.tool === 'todos_set') {
      const delta = internal.params.$array || []
      internal.params.$array = this._mergeTodo(internal.tool, delta, session)
    }

    // terax multi_edit split: one call per edit entry
    if (toolMapping.split) {
      const arrayData = internal.params.$array || []
      return arrayData
        .filter((item) => item && Object.keys(item).length > 0)
        .map((item) => {
          const args = Object.assign({}, toolMapping.default)
          for (const [genericField, ideField] of Object.entries(toolMapping.params)) {
            if (item[genericField] !== undefined) {
              args[ideField] = item[genericField]
            }
          }

          toolMapping.transform(args, item)

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

    Object.assign(result.arguments, toolMapping.default)

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
    // JSON array/object — used by MCP passthrough params (e.g. fields, paths, modifiers)
    if (
      (value.startsWith('[') && value.endsWith(']')) ||
      (value.startsWith('{') && value.endsWith('}'))
    ) {
      try {
        return JSON.parse(value)
      } catch {
        // not valid JSON — fall through and treat as a raw string
      }
    }
    return value
  }
}

const { triggers: skills } = require('./triggers')

// Precomputed trigger → skill lookup, built once at module load for O(1) matching.
const skillsByTrigger = new Map()
for (const skill of skills) {
  if (skill.trigger) skillsByTrigger.set(skill.trigger.toLowerCase(), skill)
}

/**
 * Split a remainder string into up to `n` positional args by whitespace.
 * The final arg absorbs the rest of the string (so it may itself contain
 * spaces, e.g. a Windows path with spaces) — only the first n-1 splits
 * are whitespace-delimited.
 *
 * @param {string} str
 * @param {number} n
 * @returns {string[]}
 */
function splitArgs(str, n) {
  const parts = []
  let rest = str.trim()
  for (let i = 0; i < n - 1; i++) {
    const idx = rest.search(/\s+/)
    if (idx === -1) break
    parts.push(rest.slice(0, idx))
    rest = rest.slice(idx).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

/**
 * Find the skill whose leading word matches a known trigger.
 * `text` is the trimmed/lowercased user message (used for the O(1) trigger
 * lookup); `raw` is the original untrimmed/uncased message (used to pull
 * param values with their original casing/path formatting preserved).
 *
 * Trigger param syntax: `$test d:\Project\apigen\` — everything after the
 * trigger word is split positionally into the skill's declared `params`
 * (e.g. `params: ['cwd']`), each substituted for its `#{name}#` placeholder
 * in the skill's template. Skills without a `params` array ignore any
 * trailing text.
 *
 * @param {string} text
 * @param {string} [raw]
 * @returns {object|null}
 */
ToolCompiler.matchSkill = function (text, raw) {
  if (!text) return null

  const spaceIdx = text.indexOf(' ')
  const word = spaceIdx === -1 ? text : text.slice(0, spaceIdx)

  const skill = skillsByTrigger.get(word) || matchMcpTrigger(word)
  if (!skill) return null

  const params = skill.params
  if (!params || !params.length) return skill

  const rawTrimmed = (typeof raw === 'string' ? raw : '').trim()
  const remainder = rawTrimmed.slice(word.length).trim()
  if (!remainder) return skill

  const values = splitArgs(remainder, params.length)

  let template = skill.template
  params.forEach((name, i) => {
    if (values[i] === undefined) return
    const value = values[i].replace(/[\\/]+$/, '')
    template = template.split(`#{${name}}#`).join(value)
  })

  return { ...skill, template }
}

module.exports = ToolCompiler
