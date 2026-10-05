'use strict'

/**
 * ZeroKey logging.
 *
 * Requiring this file rewires console.{log,warn,error,debug,info,success} to
 * colour, redact, prepend the caller's [file] tag (unless the call is already
 * self-tagged with a leading '['), and mirror every call to LOG_DIR/zerokey.log
 * at the matching level (success → info). The file write respects LOG_LEVEL.
 *
 * redact() / isSecretKey() strip bearer tokens, JWTs, data: URLs, SAS query
 * parameters, and any value under a secret-shaped key before it reaches disk.
 *
 * LogSaver writes LOG_DIR/<name>.log and rotates to <name>.<ISO>.log past
 * maxSize, pruning to LOG_KEEP files. Redaction is the default beforeSave.
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
    } catch {
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
  if (value instanceof Error) return value.stack || value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
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

function mapArgs(args, fn) {
  return args.map((a) => (typeof a === 'string' ? fn(a) : a))
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
  } catch {
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
    } catch {}
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
    } catch {}
  }
}

function serializeError(err) {
  if (err == null) return null
  if (typeof err !== 'object') return { value: err }

  const out = {}
  if (err instanceof Error || typeof err.stack === 'string') {
    out.name = err.name
    out.message = err.message
    out.stack = err.stack
  }
  for (const key of ['status', 'statusCode', 'code', 'type', 'cause', 'cooldownMs']) {
    if (err[key] !== undefined) {
      out[key] = err[key] instanceof Error ? serializeError(err[key]) : err[key]
    }
  }
  for (const [k, v] of Object.entries(err)) {
    if (k in out) continue
    out[k] = v instanceof Error ? serializeError(v) : v
  }
  if (Object.keys(out).length === 0) out.raw = err
  return out
}

// -- process-wide lifecycle writer ----------------------------------------

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, log: 4 }

const processSaver = new LogSaver({
  name: 'zerokey',
  dir: CONFIG.LOG_DIR,
  maxSize: CONFIG.LOG_MAX_BYTES,
  keep: CONFIG.LOG_KEEP,
})

function write(level, message) {
  if (LEVELS[level] === undefined) throw new Error('Unknown log level: ' + level)
  if (LEVELS[level] > (LEVELS[CONFIG.LOG_LEVEL] ?? LEVELS.info)) return

  const line =
    new Date().toISOString() + ' [' + level.toUpperCase().padEnd(5) + '] ' + redact(message)
  processSaver.log(line.replaceAll('\n', '\\n'))
}

// -- caller-site prefix (one shallow stack walk per call) -----------------
//
// Uses V8's structured stack (Error.prepareStackTrace) with a hard frame cap,
// so the cost is one short walk instead of stringifying the whole trace. The
// log.js frame itself is always skipped.

const MAX_STACK_FRAMES = 4
const SELF_FILE = __filename

let _prepareStackSave = null

function _captureCaller() {
  // Only install our prepareStackTrace once — it is global V8 state.
  if (_prepareStackSave === null) {
    _prepareStackSave = Error.prepareStackTrace
    Error.prepareStackTrace = (_err, structured) => structured
  }
  const previousLimit = Error.stackTraceLimit
  Error.stackTraceLimit = MAX_STACK_FRAMES
  const stack = new Error().stack
  Error.stackTraceLimit = previousLimit

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
  // Files named index.js are ambiguous — use the parent dir name instead, and
  // drop the .js suffix. Callers with a distinctive filename keep it as-is.
  let label = caller.file
  if (label === 'index.js' && caller.abs) {
    const parent = path.basename(path.dirname(caller.abs))
    if (parent) label = parent
  } else {
    label = label.replace(/\.js$/, '')
  }
  return `[${label}] `
}

// -- console methods now also write to the file ---------------------------

/**
 * Attaches the caller tag to the first argument (unless the call is
 * self-tagged or ends with a `1` marker) and strips the marker.
 * @param {any[]} rawArgs
 * @returns {{ args: any[], line: string }} console args + flat log line
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
  serializeError,
  text,
  tickWait,
}
