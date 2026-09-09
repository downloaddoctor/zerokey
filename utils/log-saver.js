const fs = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, '..', 'temp')
const DEFAULT_MAX_SIZE = 100 * 1024 // 100KB

/**
 * Rotating file logger.
 *
 * @param {object} options
 * @param {string} options.name - base log name without extension (e.g. 'glm-error')
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

      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size >= this.maxSize) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        fs.renameSync(this.logFile, path.join(DATA_DIR, `${this.name}.${ts}.log`))
      }

      fs.appendFileSync(this.logFile, line + '\n', 'utf8')
    } catch {}
  }
}

module.exports = { LogSaver, DATA_DIR, DEFAULT_MAX_SIZE }
