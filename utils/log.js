'use strict'

/**
 * ZeroKey logging: one CSV file (LOG_DIR/zerokey.log) for everything.
 *
 * Columns: ts,level,tag,msg,where,error,code,status,context,stack, separated by
 * SYNTAX.SEP (engine/syntax.js), never a comma. Every record is exactly one
 * line (fields quoted only when they hold SEP or a double quote; newlines escaped).
 * Plain messages fill ts..msg; console.error('msg', err[, ctx]) fills all.
 *
 * Cost per console call is O(1):
 *  - level gate is one integer compare (LOG_LEVEL is read once at load)
 *  - caller [FILE] tag = one captured frame, label cached per file
 *  - file size is tracked in memory (no stat per write)
 *  - stack/cause rendering is depth-capped
 *
 * Requiring this file rewires console.* to colour, redact, prepend the
 * caller [FILE] tag and mirror to disk (success maps to info).
 * redact()/isSecretKey() strip bearer tokens, JWTs, data: URLs, SAS params
 * and secret-shaped keys before anything reaches disk or console.
 */

const fs = require('fs')
const path = require('path')
const { CONFIG } = require('../config/constants')
const { SEP } = require('../engine/syntax')

const NL = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const ESC = String.fromCharCode(27)
const ESC_NL = String.fromCharCode(92) + 'n'
const MAX_CAUSE_DEPTH = 5

function reportLoggerError(err) {
  process.stderr.write('logger error: ' + String(err && err.stack ? err.stack : err) + NL)
}

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
      reportLoggerError(caughtErr)
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

function safeRedactValue(value) {
  try {
    return redactValue(value)
  } catch {
    // Circular or hostile object: fail closed rather than leak or crash the logger.
    return '<unredactable>'
  }
}

// -- formatting -----------------------------------------------------------

/** Flatten CR/LF into a literal backslash-n so a record stays one line. */
function oneLine(s) {
  if (s.indexOf(NL) === -1 && s.indexOf(CR) === -1) return s
  return s.split(CR).join('').split(NL).join(ESC_NL)
}

/** Drop ANSI colour sequences (file output must stay machine-clean). */
function stripAnsi(s) {
  if (s.indexOf(ESC) === -1) return s
  return s
    .split(ESC)
    .map((part, i) => (i === 0 ? part : part.slice(part.indexOf('m') + 1)))
    .join('')
}

/** One console argument as a plain string, without colour codes. */
function formatArg(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Error) return formatError(value)
  try {
    return JSON.stringify(value)
  } catch (caughtErr) {
    reportLoggerError(caughtErr)
    return String(value)
  }
}

function formatArgs(args) {
  return args.map(formatArg).join(' ')
}

/**
 * Plain-text Error rendering (console display and CSV source):
 *
 *   <Name>: <message> | code=<code> status=<status> type=<type>
 *   at <frame> ...
 *   caused by:
 *     <same shape, indented, depth-capped>
 */
function formatError(err, depth = 0) {
  if (!(err instanceof Error)) return formatArg(err)
  const indent = '  '.repeat(depth)
  if (depth > MAX_CAUSE_DEPTH) return indent + '...'
  const parts = []
  const name = err.name || 'Error'
  const message = oneLine(typeof err.message === 'string' ? err.message : String(err.message || ''))
  const meta = []
  if (err.code !== undefined && err.code !== '') meta.push('code=' + err.code)
  if (err.statusCode !== undefined) meta.push('status=' + err.statusCode)
  else if (err.status !== undefined) meta.push('status=' + err.status)
  if (err.type !== undefined && err.type !== '') meta.push('type=' + err.type)
  parts.push(indent + name + ': ' + message + (meta.length ? ' | ' + meta.join(' ') : ''))

  const stack = typeof err.stack === 'string' ? err.stack : ''
  if (stack) {
    // Keep only 'at ...' frames; a multi-line message must not leak in as frames.
    for (const line of stack.split(NL)) if (/^\s*at /.test(line)) parts.push(indent + line.trim())
  }

  if (err.cause instanceof Error) {
    parts.push(indent + 'caused by:')
    parts.push(formatError(err.cause, depth + 1))
  } else if (err.cause !== undefined) {
    parts.push(indent + 'caused by: ' + formatArg(err.cause))
  }
  return parts.join(NL)
}

// -- colours --------------------------------------------------------------

const codes = {
  reset: ESC + '[0m',
  dim: ESC + '[90m',
  bold: ESC + '[1m',
  green: ESC + '[32m',
  cyan: ESC + '[38;5;51m',
  yellow: ESC + '[33m',
  blue: ESC + '[38;5;33m',
  red: ESC + '[31m',
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
 * Live CR-updating countdown, e.g. "[label] WAIT 4200ms".
 * Call the returned stop function once the wait completes to clear the line.
 */
function tickWait(label, ms) {
  const start = Date.now()
  const tick = () => {
    const remaining = Math.max(0, ms - (Date.now() - start))
    process.stdout.write(CR + '[' + label + '] WAIT ' + remaining + 'ms   ')
  }
  tick()
  const interval = setInterval(tick, 1000)
  return () => {
    clearInterval(interval)
    process.stdout.write(CR + ' '.repeat(30) + CR)
  }
}

// -- CSV ------------------------------------------------------------------

const CSV_COLUMNS = [
  'ts',
  'pid',
  'level',
  'tag',
  'msg',
  'where',
  'error',
  'code',
  'status',
  'context',
  'stack',
]
const PID = process.pid
const CSV_HEADER = CSV_COLUMNS.join(SEP)
const CSV_EMPTY_TAIL = SEP.repeat(6) // where, error, code, status, context, stack

/** RFC 4180 field: quote only when needed, newlines escaped to one line. */
function csvField(value) {
  if (value === undefined || value === null || value === '') return ''
  const s = oneLine(String(value))
  if (s.indexOf(SEP) === -1 && s.indexOf('"') === -1) return s
  return '"' + s.split('"').join('""') + '"'
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
    reportLoggerError(caughtErr)
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
      reportLoggerError(caughtErr)
    }
  }
}

/**
 * Append-only line writer. Size is tracked in memory after the first write,
 * so a write is one append (no exists/stat). Writes are synchronous by
 * design: write latency is not a goal here. A header row is written whenever
 * the file starts empty (first run and after rotation).
 */
class LogSaver {
  constructor(options = {}) {
    this.name = options.name || 'app'
    this.dir = options.dir || CONFIG.LOG_DIR
    this.maxSize = options.maxSize || CONFIG.LOG_MAX_BYTES || DEFAULT_MAX_SIZE
    this.keep = Number.isInteger(options.keep) && options.keep > 0 ? options.keep : CONFIG.LOG_KEEP
    this.header = options.header || ''
    this.logFile = path.join(this.dir, this.name + '.log')
    this.size = -1
  }

  _open() {
    fs.mkdirSync(this.dir, { recursive: true })
    this.size = fs.existsSync(this.logFile) ? fs.statSync(this.logFile).size : 0
  }

  _rotate() {
    const rotated = path.join(this.dir, this.name + '.' + timestampSuffix() + '.log')
    fs.renameSync(this.logFile, rotated)
    pruneRotated(this.dir, this.name, this.keep)
    this.size = 0
  }

  log(line) {
    try {
      if (this.size < 0) this._open()
      if (this.size >= this.maxSize) this._rotate()
      let out = line + NL
      if (this.size === 0 && this.header) out = this.header + NL + out
      fs.appendFileSync(this.logFile, out, 'utf8')
      this.size += Buffer.byteLength(out)
    } catch (caughtErr) {
      reportLoggerError(caughtErr)
    }
  }
}

// -- process-wide writer --------------------------------------------------

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, log: 4 }
const THRESHOLD = LEVELS[CONFIG.LOG_LEVEL] ?? LEVELS.info

const sink = new LogSaver({
  name: 'zerokey',
  dir: CONFIG.LOG_DIR,
  maxSize: CONFIG.LOG_MAX_BYTES,
  keep: CONFIG.LOG_KEEP,
  header: CSV_HEADER,
})

/**
 * CSV row for console.error('msg', err[, ctx]). First string = summary,
 * first Error = subject, plain objects merge into context, anything else
 * lands in context.extra. Fields are redacted before CSV quoting.
 *
 * @param {string} stamp ISO timestamp
 * @param {string} tag
 * @param {any[]} rest tag-stripped console args
 * @returns {string}
 */
function errorRecord(stamp, tag, rest) {
  let summary = null
  let err = null
  let extra = null
  const context = {}
  for (const arg of rest) {
    if (err === null && arg instanceof Error) {
      err = arg
      continue
    }
    if (summary === null && typeof arg === 'string') {
      summary = arg
      continue
    }
    if (arg && typeof arg === 'object' && !Array.isArray(arg) && !(arg instanceof Error)) {
      Object.assign(context, arg)
      continue
    }
    if (arg !== undefined) (extra ||= []).push(arg instanceof Error ? formatError(arg) : arg)
  }
  if (extra) context.extra = extra
  if (context.tag !== undefined) {
    tag = String(context.tag).toUpperCase()
    delete context.tag
  }

  const lines = formatError(err).split(NL)
  let where = ''
  const frames = []
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (where === '' && line.startsWith('at ')) where = line.slice(3)
    frames.push(line)
  }

  let ctx = ''
  if (Object.keys(context).length > 0) {
    try {
      ctx = JSON.stringify(safeRedactValue(context))
    } catch {
      ctx = '<unserializable>'
    }
  }

  const msg = summary || String(err.message || 'error')
  const status = err.statusCode !== undefined ? err.statusCode : err.status
  return [
    stamp,
    PID,
    'ERROR',
    tag || 'APP',
    redact(msg),
    redact(where),
    redact(lines[0]),
    err.code,
    status,
    redact(ctx),
    redact(frames.join(' | ')),
  ]
    .map(csvField)
    .join(SEP)
}

function toRecord(level, call) {
  const stamp = new Date().toISOString()
  if (level === 'error' && call.rest.some((a) => a instanceof Error)) {
    return errorRecord(stamp, call.tag, call.rest)
  }
  const body = redact(stripAnsi(formatArgs(call.rest)))
  return (
    [csvField(stamp), PID, level.toUpperCase(), csvField(call.tag), csvField(body)].join(SEP) +
    CSV_EMPTY_TAIL
  )
}

function record(level, call) {
  if (LEVELS[level] > THRESHOLD) return
  try {
    sink.log(toRecord(level, call))
  } catch (caughtErr) {
    reportLoggerError(caughtErr)
  }
}

// -- caller tag: auto file name, one frame, cached per file ---------------

const labelCache = new Map()

function labelOf(file) {
  let label = labelCache.get(file)
  if (label !== undefined) return label
  let base = path.basename(file)
  if (base.endsWith('.js')) base = base.slice(0, -3)
  if (base === 'index') base = path.basename(path.dirname(file)) || base
  // Synthetic frames (node -e) have bracket-y names; never emit [[EVAL]].
  while (base.startsWith('[')) base = base.slice(1)
  while (base.endsWith(']')) base = base.slice(0, -1)
  label = base.toUpperCase()
  labelCache.set(file, label)
  return label
}

/**
 * Capture exactly one frame: the caller of skipFn. prepareStackTrace is
 * global V8 state (Playwright and others read error.stack), so it is
 * installed only for this capture and always restored.
 */
function callerTag(skipFn) {
  const previousPrepare = Error.prepareStackTrace
  const previousLimit = Error.stackTraceLimit
  let file = null
  try {
    Error.stackTraceLimit = 1
    Error.prepareStackTrace = (_err, structured) => structured
    const holder = {}
    Error.captureStackTrace(holder, skipFn)
    const frames = holder.stack
    const frame = Array.isArray(frames) ? frames[0] : null
    file = frame && typeof frame.getFileName === 'function' ? frame.getFileName() : null
  } catch (caughtErr) {
    reportLoggerError(caughtErr)
  } finally {
    Error.prepareStackTrace = previousPrepare
    Error.stackTraceLimit = previousLimit
  }
  return file ? labelOf(file) : ''
}

/**
 * Split raw console args into console args (tag-prefixed), the tag, and the
 * tag-stripped args used for the file record. A trailing 1 means no tag;
 * a leading [TAG] means self-tagged.
 */
function prepareCall(rawArgs, skipFn) {
  const hasMarker = rawArgs.length > 1 && rawArgs[rawArgs.length - 1] === 1
  const clean = hasMarker ? rawArgs.slice(0, -1) : rawArgs
  let tag = ''
  let rest = clean
  let args = clean
  if (!hasMarker) {
    const first = clean[0]
    if (typeof first === 'string' && first.charCodeAt(0) === 91) {
      const end = first.indexOf(']')
      if (end > 1 && end <= 40) {
        tag = first.slice(1, end).toUpperCase()
        const remainder = first.slice(end + 1).trimStart()
        rest = remainder === '' ? clean.slice(1) : [remainder, ...clean.slice(1)]
      }
    }
    if (tag === '') {
      tag = callerTag(skipFn)
      if (tag && clean.length > 0) {
        args =
          typeof first === 'string'
            ? ['[' + tag + '] ' + first, ...clean.slice(1)]
            : ['[' + tag + ']', ...clean]
      }
    }
  }
  return { args, tag, rest }
}

// -- console methods now also write to the file ---------------------------

const paint = (color) => (s) => color(redact(s))

function install(level, original, painter) {
  const fn = function (...args) {
    const call = prepareCall(args, fn)
    original(...mapArgs(call.args, painter))
    record(level, call)
  }
  return fn
}

console.warn = install('warn', _warn, paint(text.yellow))
console.error = install('error', _error, paint(text.red))
console.debug = install('debug', _debug, paint(text.dim))
console.log = install('log', _log, (s) => redact(s))
console.success = install('info', _log, paint(text.green))
console.info = install('info', _log, paint(text.blue))

console.debug.mix = function mix(...args) {
  const call = prepareCall(args, mix)
  _debug(
    ...call.args.map((a) => {
      if (typeof a !== 'string') return a
      const redacted = redact(a)
      return codes.dim + redacted.split(codes.reset).join(codes.reset + codes.dim) + codes.reset
    }),
  )
  record('debug', call)
}

module.exports = {
  isSecretKey,
  redact,
  text,
  tickWait,
}
