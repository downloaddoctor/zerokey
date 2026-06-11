const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const BASE_FILE = path.join(__dirname, 'instructions.md')
const EXTRA_FILE = path.join(__dirname, 'skills-extra.md')

class Instructions {
  constructor() {
    this._base = null
    this._extra = null
    this._hash = null
  }

  _loadBase() {
    if (this._base) return
    this._base = fs.readFileSync(BASE_FILE, 'utf8')
    this._hash = crypto.createHash('sha256').update(this._base).digest('hex')
  }

  _loadExtra() {
    if (this._extra) return
    this._extra = fs.readFileSync(EXTRA_FILE, 'utf8')
  }

  getBase() {
    this._loadBase()
    return this._base
  }

  getExtra() {
    this._loadExtra()
    return this._extra
  }

  getFull() {
    this._loadBase()
    this._loadExtra()
    return this._base + '\n\n' + this._extra
  }

  getHash() {
    this._loadBase()
    return this._hash
  }

  invalidate() {
    this._base = null
    this._extra = null
    this._hash = null
  }
}

module.exports = new Instructions()
