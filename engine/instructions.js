const fs = require('fs')
const SYNTAX = require('./syntax')
const path = require('path')
const crypto = require('crypto')

const BASE_FILE = path.join(__dirname, 'instructions.md')
const EXTRA_FILE = path.join(__dirname, 'skills-extra.md')

const FORMAT_MANDATE = `<format_mandate>
The ONLY valid format is a ${SYNTAX.NAME} block: open with ⟦, close with ⟧, params separated by ¦ with = joining key and value, no spaces around ¦ or =.
Every response consists of ${SYNTAX.NAME} block(s) only (max 6). No prose, no explanations, no text before or after blocks.
To show prose to the user, use ⟦say⟧
If information is missing or ambiguous, use the ⟦ask⟧. Never guess.

WRONG (all ignored):
  I will read the file now.
  <tool_call>{"name":"read"}</tool_call>
  read(path="/abs/file")
RIGHT:
  ⟦read¦path=/abs/file⟧

</format_mandate>`

class Instructions {
  constructor() {
    this._base = null
    this._extra = null
    this._baseHash = null
    this._fullContent = null
    this._fullHash = null
    this._claudeContent = null
    this._claudeHash = null
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
      this._fullContent = this._base + '\n' + FORMAT_MANDATE + '\n\n' + this._extra
      this._fullHash = this._sha(this._fullContent)
    }
    return { content: this._fullContent, hash: this._fullHash }
  }

  getClaudeFull() {
    this._loadBase()
    this._loadExtra()
    if (!this._claudeHash) {
      this._claudeContent = this._base + '\n\n' + this._extra
      this._claudeHash = this._sha(this._claudeContent)
    }
    return { content: this._claudeContent, hash: this._claudeHash }
  }

  invalidate() {
    this._base = null
    this._extra = null
    this._baseHash = null
    this._fullContent = null
    this._fullHash = null
    this._claudeContent = null
    this._claudeHash = null
  }
}

module.exports = new Instructions()
