const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const BASE_FILE = path.join(__dirname, 'instructions.md')
const EXTRA_FILE = path.join(__dirname, 'skills-extra.md')

const FORMAT_MANDATE = `<format_mandate>
The ONLY valid tool-call format is a BPI block: open with ⟦, close with ⟧, params separated by ¦ with = joining key and value, no spaces around ¦ or =.
NEVER emit XML tags, JSON tool calls, or function-call syntax as a means of invoking tools. Any tool invocation outside a BPI block is invalid and ignored.
Every response consists of BPI block(s) only (max 6). No prose, no explanations, no text before or after blocks.
If information is missing or ambiguous, use the ask block. Never guess.
</format_mandate>`

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
    return this._base + '\n' + FORMAT_MANDATE + '\n\n' + this._extra
  }

  getClaudeFull() {
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
