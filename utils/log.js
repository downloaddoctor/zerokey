'use strict'

/**
 * ZeroKey logging: console colouring, redaction, and rotating file writers.
 *
 * One module, three concerns, one directory:
 *
 *   1. Console mutations. After this file is required, console.warn prints
 *      yellow, console.error red, console.debug dim, console.info blue,
 *      console.success green. console.debug.mix preserves nested colour
 *      reset sequences. Every string argument passes through redact() before
 *      it reaches stdout/stderr.
 *
 *   2. redact(value) and isSecretKey(name). Bearer tokens, JWTs, data: URLs,
 *      SAS query parameters, and every value under a secret-shaped key name
 *      are replaced with "<redacted>" before they touch disk or stderr.
 *
 *   3. LogSaver. Every instance writes to LOG_DIR/<name>.log and rotates to
 *      LOG_DIR/<name>.<ISO>.log when the active file exceeds maxSize. After a
 *      rotation, files matching <name>.*.log are sorted by the ISO timestamp
 *      in their filename and the oldest are removed until only LOG_KEEP
 *      remain. Redaction is the default beforeSave; pass beforeSave: null to
 *      opt out.
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

console.warn = function (...args) {
  _warn(...mapArgs(args, (s) => text.yellow(redact(s))))
}

console.error = function (...args) {
  _error(...mapArgs(args, (s) => text.red(redact(s))))
}

console.debug = function (...args) {
  _debug(...mapArgs(args, (s) => text.dim(redact(s))))
}

console.debug.mix = function (...args) {
  _debug(
    ...args.map((a) => {
      if (typeof a !== 'string') return a
      const redacted = redact(a)
      return codes.dim + redacted.replace(/\x1b\[0m/g, '\x1b[0m' + codes.dim) + codes.reset
    }),
  )
}

console.success = function (...args) {
  _log(...mapArgs(args, (s) => text.green(redact(s))))
}

console.info = function (...args) {
  _log(...mapArgs(args, (s) => text.blue(redact(s))))
}

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

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

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
  processSaver.log(line)

  if (level === 'error') process.stderr.write(line + '\n')
}

function close() {}

module.exports = {
  LogSaver,
  close,
  debug: (m) => write('debug', m),
  error: (m) => write('error', m),
  info: (m) => write('info', m),
  isSecretKey,
  redact,
  serializeError,
  text,
  tickWait,
  warn: (m) => write('warn', m),
}
