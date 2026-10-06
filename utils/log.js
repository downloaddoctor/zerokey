'use strict'

/**
 * ZeroKey logging — one file (LOG_DIR/zerokey.log) for everything.
 *
 * Requiring this file rewires console.* to colour, redact, prepend the
 * caller's [FILE] tag, and mirror to disk at the matching level
 * (success → info). write() respects LOG_LEVEL. Errors passed as an Error
 * arg become a multi-line block (see buildErrorBlock).
 *
 * redact()/isSecretKey() strip bearer tokens, JWTs, data: URLs, SAS params,
 * and secret-shaped keys before anything reaches disk.
 */

const fs = require('fs')
const path = require('path')
const { CONFIG } = require('../config/constants')

// -- redaction ------------------------------------------------------------

const SECRET_KEY_RE =
  /^(?:access|refresh|access_token|accessToken|refresh_token|refreshToken|apiKey|api_key|id_token|cookie|authorization|secret|password|passwd|token|bearer|credential|private_key|privateKey)$/i

const REDACTIONS = [
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}={0,2}/gi, '$1<redacted>'],
  [
    /(["'](?:access|refresh|access_token|accessToken|refresh_token|refreshToken|apiKey|api_key|id_token|cookie|authorization|secret|password|passwd|token|bearer|credential|private_key|privateKey)["']\s*:\s*["'])([^"']*)(["'])/gi,
    '$1<redacted>$3',
  ],
  [
    /\b(?:access|refresh|access_token|accessToken|refresh_token|refreshToken|apiKey|api_key|id_token|cookie|authorization|secret|password|passwd|token|bearer|credential|private_key|privateKey)=([^\s&;]+)/gi,
    '<redacted>',
  ],
  [/\b(sk-)[A-Za-z0-9._-]{8,}/g, '$1<redacted>'],
  [/\b(eyJ)[A-Za-z0-9._-]{20,}/g, '$1<redacted>'],
]

function isSecretKey(name) {
  return typeof name === 'string' && SECRET_KEY_RE.test(name)
}

function redact(value) {
  if (value === null || value === undefined) return value
  let out
  if (typeof value === 'string') out = value
  else {
    try {
      out = String(value)
    } catch (caughtErr) {
      process.stderr.write(
        'logger error: ' +
          String(caughtErr && caughtErr.stack ? caughtErr.stack : caughtErr) +
          '\n',
      )
      return '<unprintable>'
    }
  }
  out = out.replace(/(data:[^;,\s]+;base64,)[A-Za-z0-9+/_=-]+/gi, (_m, p) => p + '<redacted>')
  out = out.replace(/([?&](?:se|sig|sp|spr|srt|ss|st|sv)=)[^&#\s]*/gi, (_m, p) => p + '<redacted>')
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out
}

function redactValue(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redact(value)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redactValue)
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (isSecretKey(k) && v !== null && v !== undefined) {
      out[k] = '<redacted>'
      continue
    }
    out[k] = redactValue(v)
  }
  return out
}

/** One console argument as a plain string, without colour codes. */
function formatArg(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Error) {
    return formatError(value)
  }
  try {
    return JSON.stringify(value)
  } catch (caughtErr) {
    process.stderr.write(
      'logger error: ' + String(caughtErr && caughtErr.stack ? caughtErr.stack : caughtErr) + '\n',
    )
    return String(value)
  }
}

/**
 * LLM-first Error rendering. Shape:
 *
 *   <Name>: <message> | code=<code> status=<status> type=<type>
 *   <stack frame 1>
 *   <stack frame 2>
 *   ...
 *   caused by: <same shape, indented>
 *
 * Kept as plain text so every log line is grep-able and the full stack
 * is always present — the first frame is the "where", the header is the
 * "what", the tail fields are the "why". No colour codes here: the file
 * mirror must stay machine-clean.
 */
function formatError(err, depth = 0) {
  if (!(err instanceof Error)) return formatArg(err)
  const indent = '  '.repeat(depth)
  const parts = []
  const name = err.name || 'Error'
  const message = typeof err.message === 'string' ? err.message : String(err.message || '')
  const meta = []
  if (err.code !== undefined && err.code !== '') meta.push('code=' + err.code)
  if (err.statusCode !== undefined) meta.push('status=' + err.statusCode)
  else if (err.status !== undefined) meta.push('status=' + err.status)
  if (err.type !== undefined && err.type !== '') meta.push('type=' + err.type)
  parts.push(indent + name + ': ' + message + (meta.length ? ' | ' + meta.join(' ') : ''))

  const stack = typeof err.stack === 'string' ? err.stack : ''
  if (stack) {
    const lines = stack.split('\n')
    // Keep only 'at ...' frames; a multi-line message must not leak in as frames.
    for (const line of lines) if (/^\s*at /.test(line)) parts.push(indent + line.trim())
  }

  if (err.cause instanceof Error) {
    parts.push(indent + 'caused by:')
    parts.push(formatError(err.cause, depth + 1))
  } else if (err.cause !== undefined) {
    parts.push(indent + 'caused by: ' + formatArg(err.cause))
  }
  return parts.join('\n')
}

function formatArgs(args) {
  return args.map(formatArg).join(' ')
}

// -- console mutations ----------------------------------------------------

const codes = {
  reset: '\x1b[0m',
  dim: '\x1b[90m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[38;5;51m',
  yellow: '\x1b[33m',
  blue: '\x1b[38;5;33m',
  red: '\x1b[31m',
}

function make(tag) {
  const code = codes[tag]
  return function (text) {
    return code + text + codes.reset
  }
}

const text = {
  dim: make('dim'),
  bold: make('bold'),
  green: make('green'),
  cyan: make('cyan'),
  yellow: make('yellow'),
  blue: make('blue'),
  red: make('red'),
}

const _log = console.log.bind(console)
const _warn = console.warn.bind(console)
const _error = console.error.bind(console)
const _debug = console.debug.bind(console)

function safeRedactValue(value) {
  try {
    return redactValue(value)
  } catch {
    // Circular or hostile object: fail closed rather than leak or crash the logger.
    return '<unredactable>'
  }
}

function mapArgs(args, fn) {
  // Error arguments become their redacted stack, so console.error(msg, err)
  // always shows the full trace without the caller formatting it.
  return args.map((a) =>
    a instanceof Error
      ? fn(formatArg(a))
      : typeof a === 'string'
        ? fn(a)
        : a && typeof a === 'object'
          ? safeRedactValue(a)
          : a,
  )
}

/**
 * Live `\r`-updating countdown, e.g. "[label] WAIT 4200ms".
 * Call the returned stop function once the wait completes to clear the line.
 */
function tickWait(label, ms) {
  const start = Date.now()
  const tick = () => {
    const remaining = Math.max(0, ms - (Date.now() - start))
    process.stdout.write('\r[' + label + '] WAIT ' + remaining + 'ms   ')
  }
  tick()
  const interval = setInterval(tick, 1000)
  return () => {
    clearInterval(interval)
    process.stdout.write('\r' + ' '.repeat(30) + '\r')
  }
}

// -- rotating file writer -------------------------------------------------

const DEFAULT_MAX_SIZE = 100 * 1024

function timestampSuffix() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function listRotated(logDir, name) {
  const prefix = name + '.'
  const suffix = '.log'
  let entries
  try {
    entries = fs.readdirSync(logDir)
  } catch (caughtErr) {
    process.stderr.write(
      'logger error: ' + String(caughtErr && caughtErr.stack ? caughtErr.stack : caughtErr) + '\n',
    )
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue
    const middle = entry.slice(prefix.length, entry.length - suffix.length)
    if (middle === '') continue
    out.push({ file: path.join(logDir, entry), stamp: middle })
  }
  return out
}

function pruneRotated(logDir, name, keep) {
  const rotated = listRotated(logDir, name)
  if (rotated.length <= keep) return
  rotated.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0))
  const excess = rotated.length - keep
  for (let i = 0; i < excess; i += 1) {
    try {
      fs.unlinkSync(rotated[i].file)
    } catch (caughtErr) {
      process.stderr.write(
        'logger error: ' +
          String(caughtErr && caughtErr.stack ? caughtErr.stack : caughtErr) +
          '\n',
      )
    }
  }
}

class LogSaver {
  constructor(options = {}) {
    this.name = options.name || 'app'
    this.dir = options.dir || CONFIG.LOG_DIR
    this.maxSize = options.maxSize || CONFIG.LOG_MAX_BYTES || DEFAULT_MAX_SIZE
    this.keep = Number.isInteger(options.keep) && options.keep > 0 ? options.keep : CONFIG.LOG_KEEP
    this.beforeSave =
      options.beforeSave === undefined
        ? (entry) => (typeof entry === 'string' ? redact(entry) : redactValue(entry))
        : options.beforeSave
    this.logFile = path.join(this.dir, this.name + '.log')
  }

  log(entry) {
    try {
      if (this.beforeSave) {
        entry = this.beforeSave(entry)
        if (entry == null) return
      }

      const line = typeof entry === 'string' ? entry : JSON.stringify(entry)

      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true })

      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size >= this.maxSize) {
        const rotated = path.join(this.dir, this.name + '.' + timestampSuffix() + '.log')
        fs.renameSync(this.logFile, rotated)
        pruneRotated(this.dir, this.name, this.keep)
      }

      fs.appendFileSync(this.logFile, line + '\n', 'utf8')
    } catch (caughtErr) {
      process.stderr.write(
        'logger error: ' +
          String(caughtErr && caughtErr.stack ? caughtErr.stack : caughtErr) +
          '\n',
      )
    }
  }
}

// -- process-wide lifecycle writer ----------------------------------------

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, log: 4 }

const processSaver = new LogSaver({
  name: 'zerokey',
  dir: CONFIG.LOG_DIR,
  maxSize: CONFIG.LOG_MAX_BYTES,
  keep: CONFIG.LOG_KEEP,
})

/**
 * Single-line entries escape newlines (grep-friendly); block entries keep
 * real newlines and are bookended by blank lines.
 *
 * @param {'error'|'warn'|'info'|'debug'|'log'} level
 * @param {string} message
 * @param {{block?: boolean}} [opts]
 */
function write(level, message, opts) {
  if (LEVELS[level] === undefined) throw new Error('Unknown log level: ' + level)
  if (LEVELS[level] > (LEVELS[CONFIG.LOG_LEVEL] ?? LEVELS.info)) return

  const stamp = new Date().toISOString()
  const tag = '[' + level.toUpperCase().padEnd(5) + '] '
  const safe = redact(message)
  if (opts && opts.block) {
    // Stamp the first line; indent the rest so the block reads as one unit.
    const lines = safe.split('\n')
    const head = stamp + ' ' + tag + lines[0]
    const rest = lines.slice(1).map((l) => '                     ' + l)
    processSaver.log('\n' + [head, ...rest].join('\n') + '\n')
    return
  }

  const oneLine = safe.split('\n').join(String.fromCharCode(92) + 'n')
  processSaver.log(stamp + ' ' + tag + oneLine)
}
// -- structured error block ------------------------------------------------
//
// Shape (findable via '[ERROR] ───'):
//   2026-… [ERROR] ─── [TAG] summary ───
//                        where: <file:line>
//                        context: {...redacted...}
//                        Error: msg | code=… status=…
//                          at frame
//                          caused by: …

/**
 * Build the block body for console.error('msg', err[, ctx]), or null if no
 * Error is present (caller falls back to a single line). First string =
 * summary, first Error = subject, remaining plain objects merge into context.
 *
 * @param {any[]} args  caller-tag-prefixed console args
 * @returns {string|null}
 */
function buildErrorBlock(args) {
  let summary = null
  let err = null
  const context = {}
  for (const arg of args) {
    if (err === null && arg instanceof Error) {
      err = arg
      continue
    }
    if (summary === null && typeof arg === 'string') {
      summary = arg
      continue
    }
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      Object.assign(context, arg)
    } else if (arg !== undefined) {
      // Never drop extra args (second string, array, number, second Error).
      ;(context.extra ||= []).push(arg instanceof Error ? formatError(arg) : arg)
    }
  }
  if (err === null) return null

  // Summary may carry [TAG] (from _prepareCall); don't double it.
  let safeTag = String(context.tag || '').toUpperCase()
  delete context.tag
  let headlineText = summary || err.message || 'error'
  const tagMatch = headlineText.match(/^\[([^\]]+)\]\s*(.*)$/)
  if (tagMatch) {
    if (!safeTag) safeTag = tagMatch[1].toUpperCase()
    headlineText = tagMatch[2]
  }
  if (!safeTag) safeTag = 'APP'

  const headline = '─── [' + safeTag + '] ' + headlineText + ' ───'
  const body = [headline]

  const whereMatch = typeof err.stack === 'string' ? err.stack.match(/\n\s*at\s+([^\n]+)/) : null
  if (whereMatch) body.push('where: ' + whereMatch[1].trim())

  if (Object.keys(context).length > 0) {
    try {
      body.push('context: ' + JSON.stringify(redactValue(context)))
    } catch (caughtErr) {
      body.push('context: <unserializable: ' + (caughtErr && caughtErr.message) + '>')
    }
  }

  body.push(formatError(err))
  return body.join('\n')
}

// -- caller-site prefix (one shallow stack walk per call) -----------------
// Uses V8's structured stack with a frame cap; the log.js frame is skipped.

const MAX_STACK_FRAMES = 6
const SELF_FILE = __filename

function _captureCaller() {
  // prepareStackTrace is global V8 state — install only here, always restore.
  const previousPrepare = Error.prepareStackTrace
  const previousLimit = Error.stackTraceLimit
  let stack
  try {
    Error.prepareStackTrace = (_err, structured) => structured
    Error.stackTraceLimit = MAX_STACK_FRAMES
    stack = new Error().stack
  } catch (caughtErr) {
    process.stderr.write(
      'logger error: ' + String(caughtErr && caughtErr.stack ? caughtErr.stack : caughtErr) + '\n',
    )
    stack = null
  } finally {
    Error.prepareStackTrace = previousPrepare
    Error.stackTraceLimit = previousLimit
  }

  if (!Array.isArray(stack)) return null
  for (const frame of stack) {
    const file = typeof frame.getFileName === 'function' ? frame.getFileName() : null
    if (!file || file === SELF_FILE) continue
    const line = typeof frame.getLineNumber === 'function' ? frame.getLineNumber() : 0
    return { file: path.basename(file), abs: file, line }
  }
  return null
}

function _callerTag() {
  const caller = _captureCaller()
  if (!caller) return ''
  // index.js is ambiguous → use the parent dir name instead.
  let label = caller.file
  if (label === 'index.js' && caller.abs) {
    const parent = path.basename(path.dirname(caller.abs))
    if (parent) label = parent
  } else {
    label = label.replace(/\.js$/, '')
  }
  // Synthetic frames (node -e) have bracket-y names; strip so we never emit [[EVAL] ].
  const clean = label.replace(/^\[+|\]+$/g, '')
  return `[${clean.toUpperCase()}] `
}

// -- console methods now also write to the file ---------------------------

/**
 * Prefix the first arg with the caller [TAG] unless self-tagged or a `1`
 * marker is passed. Returns colour-ready args + a flat log line.
 *
 * @param {any[]} rawArgs
 * @returns {{ args: any[], line: string }}
 */
function _prepareCall(rawArgs) {
  const hasMarker = rawArgs.length > 1 && rawArgs[rawArgs.length - 1] === 1
  const clean = hasMarker ? rawArgs.slice(0, -1) : rawArgs

  const first = clean[0]
  const selfTagged = typeof first === 'string' && first.startsWith('[')
  const prefix = hasMarker || selfTagged ? '' : _callerTag()

  const args = prefix && clean.length > 0 ? [prefix + clean[0], ...clean.slice(1)] : clean
  const line = prefix + formatArgs(clean)

  return { args, line }
}

console.warn = function (...args) {
  const { args: clean, line } = _prepareCall(args)
  _warn(...mapArgs(clean, (s) => text.yellow(redact(s))))
  write('warn', line)
}

console.error = function (...args) {
  const { args: clean, line } = _prepareCall(args)
  _error(...mapArgs(clean, (s) => text.red(redact(s))))

  // console.error('msg', err[, ctx]) → structured block; else flat line.
  const structured = buildErrorBlock(clean)
  if (structured) {
    write('error', structured, { block: true })
    return
  }
  write('error', line)
}

console.debug = function (...args) {
  const { args: clean, line } = _prepareCall(args)
  _debug(...mapArgs(clean, (s) => text.dim(redact(s))))
  write('debug', line)
}

console.debug.mix = function (...args) {
  const { args: clean, line } = _prepareCall(args)
  _debug(
    ...clean.map((a) => {
      if (typeof a !== 'string') return a
      const redacted = redact(a)
      return codes.dim + redacted.replace(/\x1b\[0m/g, '\x1b[0m' + codes.dim) + codes.reset
    }),
  )
  write('debug', line)
}

console.log = function (...args) {
  const { args: clean, line } = _prepareCall(args)
  _log(...mapArgs(clean, (s) => redact(s)))
  write('log', line)
}

console.success = function (...args) {
  const { args: clean, line } = _prepareCall(args)
  _log(...mapArgs(clean, (s) => text.green(redact(s))))
  write('info', line)
}

console.info = function (...args) {
  const { args: clean, line } = _prepareCall(args)
  _log(...mapArgs(clean, (s) => text.blue(redact(s))))
  write('info', line)
}

module.exports = {
  LogSaver,
  isSecretKey,
  redact,
  text,
  tickWait,
}
