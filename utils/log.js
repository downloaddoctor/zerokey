'use strict'

/**
 * Central log with redact-before-write discipline.
 *
 * Contract: nothing reaches disk or the console without passing through
 * `redact()`. A log that cannot be shown to the user because it contains a
 * token is not a log — so the caller is not trusted to be careful.
 */

const fs = require('fs')
const path = require('path')
const { CONFIG } = require('../config/constants')

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

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
  let out = typeof value === 'string' ? value : String(value)
  out = out.replace(/(data:[^;,\s]+;base64,)[A-Za-z0-9+/_=-]+/gi, (_m, p) => p + '<redacted>')
  out = out.replace(/([?&](?:se|sig|sp|spr|srt|ss|st|sv)=)[^&#\s]*/gi, (_m, p) => p + '<redacted>')
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out
}

let handle = null
let bytes = 0

function logFile() {
  return path.join(CONFIG.LOG_DIR, 'zerokey.log')
}

function openHandle() {
  fs.mkdirSync(CONFIG.LOG_DIR, { recursive: true })
  handle = fs.openSync(logFile(), 'a')
  bytes = fs.fstatSync(handle).size
}

function rotate() {
  if (handle !== null) {
    fs.closeSync(handle)
    handle = null
  }
  const keep = CONFIG.LOG_KEEP
  const oldest = logFile() + '.' + keep
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest)
  for (let i = keep - 1; i >= 1; i -= 1) {
    const from = logFile() + '.' + i
    if (fs.existsSync(from)) fs.renameSync(from, logFile() + '.' + (i + 1))
  }
  if (fs.existsSync(logFile())) fs.renameSync(logFile(), logFile() + '.1')
  openHandle()
}

function write(level, message) {
  if (LEVELS[level] === undefined) throw new Error('Unknown log level: ' + level)
  if (LEVELS[level] > (LEVELS[CONFIG.LOG_LEVEL] ?? LEVELS.info)) return

  const line =
    new Date().toISOString() + ' [' + level.toUpperCase().padEnd(5) + '] ' + redact(message) + '\n'
  const size = Buffer.byteLength(line)

  try {
    if (handle === null) openHandle()
    if (bytes + size > CONFIG.LOG_MAX_BYTES) rotate()
    fs.writeSync(handle, line)
    bytes += size
  } catch (err) {
    process.stderr.write('LOG ERROR: ' + err.message + '\n')
  }

  if (level === 'error') process.stderr.write(line)
}

function close() {
  if (handle !== null) {
    fs.closeSync(handle)
    handle = null
    bytes = 0
  }
}

module.exports = {
  isSecretKey,
  redact,
  close,
  file: logFile,
  error: (m) => write('error', m),
  warn: (m) => write('warn', m),
  info: (m) => write('info', m),
  debug: (m) => write('debug', m),
}
