'use strict'

/**
 * Tool bridge for providers with no native tool channel.
 *
 * Delimiters come straight from engine/syntax.js. Never restate them here —
 * a literal copy is both redundant and a hazard (the bytes are easy to leak
 * through any tool that treats them specially).
 *
 * Two directions:
 *   out - preparePayload() prepends a grammar block to the last user message
 *   when payload.tools[] is non-empty.
 *   in  - evaluateAssistant() parses emitted blocks back into OpenAI-shaped
 *   tool_calls.
 */

const SYNTAX = require('./syntax')

const OPEN = SYNTAX.OPEN
const CLOSE = SYNTAX.CLOSE
const SEP = SYNTAX.SEP

const MAX_TOOLS = 128
const MAX_CALLS = 12
const MAX_DESCRIPTION_CHARS = 240

function rawName(tool) {
  if (!tool || typeof tool !== 'object') return null
  const value =
    tool.function && typeof tool.function.name === 'string'
      ? tool.function.name
      : typeof tool.name === 'string'
        ? tool.name
        : null
  return value && value.trim() ? value.trim() : null
}

function schemaOf(tool) {
  if (
    tool &&
    tool.function &&
    tool.function.parameters &&
    typeof tool.function.parameters === 'object'
  ) {
    return tool.function.parameters
  }
  if (tool && tool.input_schema && typeof tool.input_schema === 'object') return tool.input_schema
  if (tool && tool.parameters && typeof tool.parameters === 'object') return tool.parameters
  return {}
}

function descriptionOf(tool) {
  const value =
    tool && tool.function && typeof tool.function.description === 'string'
      ? tool.function.description
      : tool && typeof tool.description === 'string'
        ? tool.description
        : ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS)
}

function typeHint(definition) {
  if (definition && (definition.type === 'integer' || definition.type === 'number')) return 'int'
  if (definition && definition.type === 'boolean') return 'bool'
  if (definition && (definition.type === 'array' || definition.type === 'object')) return 'json'
  return 'str'
}

function buildRegistry(tools) {
  const entries = []
  for (const tool of Array.isArray(tools) ? tools.slice(0, MAX_TOOLS) : []) {
    const name = rawName(tool)
    if (!name) continue
    entries.push({ name, schema: schemaOf(tool), description: descriptionOf(tool) })
  }
  const byName = new Map()
  for (const entry of entries) byName.set(entry.name, entry)
  return { entries, byName }
}

function syntaxFor(entry) {
  const properties =
    entry.schema && entry.schema.properties && typeof entry.schema.properties === 'object'
      ? entry.schema.properties
      : {}
  const required = new Set(
    entry.schema && Array.isArray(entry.schema.required) ? entry.schema.required : [],
  )

  let line = OPEN + entry.name
  for (const [key, definition] of Object.entries(properties)) {
    const fragment = SEP + key + '={' + typeHint(definition) + '}'
    line += required.has(key) ? fragment : '(' + fragment + ')?'
  }
  line += CLOSE
  if (entry.description) line += ' - ' + entry.description
  return line
}

function grammarBlock(entries) {
  const lines = [
    '<mhi_tools>',
    'These tools are executable through the ZeroKey host. To call one, emit a block',
    'exactly in the syntax below; the host runs it and returns the result in the next turn.',
    '',
    'Syntax: ' + OPEN + 'tool' + SEP + 'key=value' + SEP + 'key=value' + CLOSE,
    'Do not run tools locally. Emit only complete blocks, no prose, when a tool is needed.',
    'At most ' + MAX_CALLS + ' blocks per response.',
    '',
    'Available tools:',
  ]
  for (const entry of entries) lines.push('  ' + syntaxFor(entry))
  lines.push('</mhi_tools>')
  return lines.join('\n')
}

function prependToLastUser(messages, block) {
  const list = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].role === 'user') {
      const current = list[i].content
      if (typeof current === 'string') {
        list[i].content = block + '\n\n' + current
      } else if (Array.isArray(current)) {
        list[i].content = [{ type: 'text', text: block + '\n\n' }, ...current]
      } else {
        list[i].content = block
      }
      return list
    }
  }
  return list
}

function preparePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const registry = buildRegistry(payload.tools)
  if (registry.entries.length === 0) return payload

  const lastUser = [...(payload.messages || [])].reverse().find((m) => m && m.role === 'user')
  if (
    lastUser &&
    typeof lastUser.content === 'string' &&
    lastUser.content.includes('<mhi_tools>')
  ) {
    return payload
  }

  const block = grammarBlock(registry.entries)
  return { ...payload, messages: prependToLastUser(payload.messages, block) }
}

function repairPrompt() {
  return (
    '<mhi_repair>' +
    'The previous response mixed tool blocks with prose. Resend only the complete blocks, ' +
    'with no text before or after them. If no tool is needed, answer in plain prose without ' +
    'any ' +
    OPEN +
    ' or ' +
    CLOSE +
    ' characters.' +
    '</mhi_repair>'
  )
}

function parseBlock(rawBody) {
  const parts = SYNTAX.splitPayload(rawBody).filter(Boolean)
  const name = parts.shift()
  if (!name) return null
  const params = {}
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq)
    const value = part.slice(eq + 1)
    if (Object.prototype.hasOwnProperty.call(params, key)) return null
    params[key] = value
  }
  return { name, params }
}

function coerceArguments(params, schema) {
  const properties =
    schema && schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
  const out = {}
  for (const [key, value] of Object.entries(params)) {
    const def = properties[key]
    if (!def) {
      out[key] = value
      continue
    }
    if (def.type === 'boolean') {
      out[key] = value === 'true' ? true : value === 'false' ? false : value
    } else if (def.type === 'integer' && /^-?\d+$/.test(value)) {
      out[key] = Number.parseInt(value, 10)
    } else if (def.type === 'number' && /^-?\d+(?:\.\d+)?$/.test(value)) {
      out[key] = Number.parseFloat(value)
    } else if (
      (def.type === 'array' || def.type === 'object') &&
      ((value.startsWith('[') && value.endsWith(']')) ||
        (value.startsWith('{') && value.endsWith('}')))
    ) {
      try {
        out[key] = JSON.parse(value)
      } catch {
        out[key] = value
      }
    } else {
      out[key] = value
    }
  }
  return out
}

function evaluateAssistant(text, payload) {
  const value = typeof text === 'string' ? text : String(text || '')
  if (!value.includes(OPEN)) return { kind: 'final', text: value }

  const blocks = []
  let outside = ''
  let cursor = 0
  for (;;) {
    const start = value.indexOf(OPEN, cursor)
    if (start === -1) {
      outside += value.slice(cursor)
      break
    }
    outside += value.slice(cursor, start)
    const end = value.indexOf(CLOSE, start + 1)
    if (end === -1) {
      return { kind: 'continue', prompt: repairPrompt(), reason: 'incomplete_block' }
    }
    blocks.push(value.slice(start + 1, end))
    cursor = end + 1
  }

  if (blocks.length === 0) return { kind: 'final', text: value }

  if (outside.trim() !== '') {
    return { kind: 'continue', prompt: repairPrompt(), reason: 'mixed_output' }
  }

  if (blocks.length > MAX_CALLS) {
    return {
      kind: 'continue',
      prompt:
        '<mhi_repair>At most ' +
        MAX_CALLS +
        ' blocks per response. Split into batches and continue after the results arrive.</mhi_repair>',
      reason: 'too_many_calls',
    }
  }

  const registry = buildRegistry(payload && payload.tools)
  const calls = []
  for (let i = 0; i < blocks.length; i += 1) {
    const parsed = parseBlock(blocks[i])
    if (!parsed) {
      return { kind: 'continue', prompt: repairPrompt(), reason: 'invalid_block' }
    }
    const entry = registry.byName.get(parsed.name)
    const args = entry ? coerceArguments(parsed.params, entry.schema) : parsed.params
    calls.push({
      id: 'call_' + String(i).padStart(4, '0') + '_' + parsed.name,
      type: 'function',
      function: { name: parsed.name, arguments: JSON.stringify(args) },
    })
  }
  return { kind: 'calls', calls }
}

module.exports = {
  MAX_CALLS,
  MAX_TOOLS,
  buildRegistry,
  evaluateAssistant,
  grammarBlock,
  parseBlock,
  preparePayload,
  repairPrompt,
  syntaxFor,
}
