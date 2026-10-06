'use strict'

/**
 * MHI block parser used by the internal executors.
 *
 * Returns { kind: 'calls', calls } or { kind: 'text', text } from
 * parseAssistantText, or a single { tool, params } from parseBlock. Throws
 * { code, message } on malformed input; the caller turns that into a repair
 * round.
 */

const SYNTAX = require('../../engine/syntax')

const OPEN = SYNTAX.OPEN
const CLOSE = SYNTAX.CLOSE

const MAX_BLOCKS = 12
const MAX_BLOCK_CHARS = 1024 * 1024
const MAX_TOTAL_CHARS = 2 * 1024 * 1024

const DEFINITIONS = {
  read: { keys: new Set(['path', 'from', 'to']), required: ['path'] },
  grep: {
    keys: new Set(['query', 'queryR', 'glob', 'max']),
    requiredOneOf: [['query', 'queryR']],
  },
  write: { keys: new Set(['path', 'content']), required: ['path', 'content'] },
  replace: { keys: new Set(['path', 'old', 'new']), required: ['path', 'old', 'new'] },
  ls: { keys: new Set(['path']), required: [] },
  glob: { keys: new Set(['pattern', 'dir', 'max']), required: ['pattern'] },
  view_image: { keys: new Set(['path']), required: ['path'] },
  cmd: { keys: new Set(['program', 'args', 'cwd', 'timeout']), required: ['program'] },
}

class MhiParseError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MhiParseError'
    this.code = code
  }
}

function positiveInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(value)) {
    throw new MhiParseError('mhi_invalid_parameter', name + ' must be an integer.')
  }
  const parsed = Number.parseInt(value, 10)
  if (parsed < minimum || parsed > maximum) {
    throw new MhiParseError('mhi_parameter_out_of_range', name + ' is out of range.')
  }
  return parsed
}

function parseBlock(rawBody) {
  if (rawBody.length > MAX_BLOCK_CHARS) {
    throw new MhiParseError('mhi_block_too_large', 'A block is too large.')
  }
  const parts = SYNTAX.splitPayload(rawBody).filter((p) => p !== '')
  let tool = String(parts.shift() || '').trim()
  // The model sometimes echoes a prior result header ("MHI(ls): ...") back as
  // a call. Unwrap the MHI(...) wrapper so a real tool name underneath still
  // resolves; anything else stays as-is and fails the lookup below.
  const echo = tool.match(/^MHI\(([A-Za-z0-9_]+)\)$/)
  if (echo) tool = echo[1]
  const definition = DEFINITIONS[tool]
  if (!definition) {
    throw new MhiParseError('mhi_unknown_tool', 'Unknown tool: ' + (tool || '(empty)'))
  }

  const params = {}
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq <= 0) {
      throw new MhiParseError('mhi_invalid_parameter', 'Each parameter must be name=value.')
    }
    const key = part.slice(0, eq)
    const value = part.slice(eq + 1)
    if (!definition.keys.has(key)) {
      const allowed = Array.from(definition.keys).join(', ')
      throw new MhiParseError(
        'mhi_unknown_parameter',
        'Unknown parameter "' + key + '" for ' + tool + '. Allowed: ' + allowed + '.',
      )
    }
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      throw new MhiParseError('mhi_duplicate_parameter', 'Duplicate parameter: ' + key)
    }
    params[key] = value
  }

  for (const key of definition.required || []) {
    if (!Object.prototype.hasOwnProperty.call(params, key) || params[key] === '') {
      throw new MhiParseError('mhi_missing_parameter', 'Missing required parameter: ' + key)
    }
  }
  for (const alternatives of definition.requiredOneOf || []) {
    const present = alternatives.filter(
      (k) => Object.prototype.hasOwnProperty.call(params, k) && params[k] !== '',
    )
    if (present.length !== 1) {
      throw new MhiParseError(
        'mhi_parameter_conflict',
        'Exactly one of these is required: ' + alternatives.join(', '),
      )
    }
  }

  if (params.from !== undefined) params.from = positiveInteger(params.from, 'from', 1, 1000000)
  if (params.to !== undefined) params.to = positiveInteger(params.to, 'to', 1, 1000000)
  if (params.from !== undefined && params.to !== undefined && params.to < params.from) {
    throw new MhiParseError('mhi_invalid_range', 'to must be >= from')
  }
  if (params.max !== undefined) params.max = positiveInteger(params.max, 'max', 1, 500)
  if (params.timeout !== undefined) {
    params.timeout = positiveInteger(params.timeout, 'timeout', 100, 120000)
  }

  return { tool, params }
}

function parseAssistantText(text) {
  const value = typeof text === 'string' ? text : String(text || '')
  if (value.length > MAX_TOTAL_CHARS) {
    throw new MhiParseError('mhi_output_too_large', 'Assistant output is too large.')
  }
  if (!value.includes(OPEN)) return { kind: 'text', text: value }

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
      throw new MhiParseError('mhi_incomplete_block', 'An incomplete block was not executed.')
    }
    blocks.push(value.slice(start + 1, end))
    cursor = end + 1
  }

  if (blocks.length === 0 || outside.trim() !== '') {
    return { kind: 'text', text: value, mixed: blocks.length > 0 }
  }
  if (blocks.length > MAX_BLOCKS) {
    throw new MhiParseError('mhi_too_many_blocks', 'At most ' + MAX_BLOCKS + ' blocks per turn.')
  }
  return { kind: 'calls', calls: blocks.map(parseBlock) }
}

module.exports = {
  MhiParseError,
  DEFINITIONS,
  MAX_BLOCKS,
  parseAssistantText,
  parseBlock,
}
