const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const BASE_FILE = path.join(__dirname, 'instructions.md')
const EXTRA_FILE = path.join(__dirname, 'skills-extra.md')

class Instructions {
  constructor() {
    this._base = null
    this._extra = null
    this._baseHash = null
    this._fullContent = null
    this._fullHash = null
  }

  _loadBase() {
    if (this._base) return
    this._base = fs.readFileSync(BASE_FILE, 'utf8')
  }

  _loadExtra() {
    if (this._extra) return
    this._extra = fs.readFileSync(EXTRA_FILE, 'utf8')
  }

  _sha(content) {
    return crypto.createHash('sha256').update(content).digest('hex')
  }

  /**
   * Returns { content, hash } for each payload variant.
   * The hash is always of the exact content returned, so callers can
   * safely compare userData.instructionsHash === hash before writing.
   */
  getBase() {
    this._loadBase()
    if (!this._baseHash) this._baseHash = this._sha(this._base)
    return { content: this._base, hash: this._baseHash }
  }

  getExtra() {
    this._loadExtra()
    return this._extra
  }

  getFull() {
    this._loadBase()
    this._loadExtra()
    if (!this._fullHash) {
      this._fullContent = this._base + '\n\n' + this._extra
      this._fullHash = this._sha(this._fullContent)
    }
    return { content: this._fullContent, hash: this._fullHash }
  }

  invalidate() {
    this._base = null
    this._extra = null
    this._baseHash = null
    this._fullContent = null
    this._fullHash = null
  }
}

module.exports = new Instructions()
