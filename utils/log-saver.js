const fs = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, '..', 'temp')
const DEFAULT_MAX_SIZE = 100 * 1024 // 100KB

/**
 * Rotating file logger.
 *
 * @param {object} options
 * @param {string} options.name - base log name without extension (e.g. 'deepseek-error')
 * @param {number} [options.maxSize=102400] - bytes before rotating
 * @param {(entry: object) => object|null} [options.beforeSave] - optional transform
 *   called before writing; return null to skip writing this entry
 */
class LogSaver {
  constructor(options = {}) {
    this.name = options.name || 'app'
    this.maxSize = options.maxSize || DEFAULT_MAX_SIZE
    this.beforeSave = options.beforeSave || null
    this.logFile = path.join(DATA_DIR, `${this.name}.log`)
  }

  log(entry) {
    try {
      if (this.beforeSave) {
        entry = this.beforeSave(entry)
        if (entry == null) return
      }

      const line = typeof entry === 'string' ? entry : JSON.stringify(entry)

      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size >= this.maxSize) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        fs.renameSync(this.logFile, path.join(DATA_DIR, `${this.name}.${ts}.log`))
      }

      fs.appendFileSync(this.logFile, line + '\n', 'utf8')
    } catch {}
  }
}

/**
 * Flatten an Error (or error-like object) into a plain JSON-safe object with
 * every field the handlers might attach: message, name, stack, status,
 * statusCode, code, type, cause, plus any extra own enumerable props.
 * Non-Error inputs are returned as-is (already plain).
 *
 * @param {*} err
 * @returns {object}
 */
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
  // preserve any other own enumerable fields (e.g. provider error payloads)
  for (const [k, v] of Object.entries(err)) {
    if (k in out) continue
    out[k] = v instanceof Error ? serializeError(v) : v
  }
  // if it wasn't Error-shaped at all, at least return the object
  if (Object.keys(out).length === 0) out.raw = err
  return out
}

module.exports = { LogSaver, serializeError, DATA_DIR, DEFAULT_MAX_SIZE }
