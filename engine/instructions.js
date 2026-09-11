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

SELF-CHECK before every response - if ANY answer is no, you have forgotten the tools and must rewrite before sending:
1. Did I use a real BPI block from bpi_list, not prose or a built-in tool?
2. Is every block wrapped in ⟦ ... ⟧ with ¦ separators and no stray spaces?
3. Is there zero text outside the blocks?
4. If I need info, did I emit the ask block instead of asking in plain text?

WRONG (all ignored):
  I will read the file now.
  <tool_call>{"name":"read"}</tool_call>
  read(path="/abs/file")
RIGHT:
  ⟦read¦path=/abs/file⟧

If you drift to prose or built-in tool calls mid-conversation, the user may type $tools to re-inject this contract - comply immediately and resume emitting only BPI blocks.
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
