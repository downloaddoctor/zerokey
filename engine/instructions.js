const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const EXTRA_DIR = path.join(__dirname, 'extra')

class Instructions {
  constructor() {
    this._skills = {}
  }

  _sha(content) {
    return crypto.createHash('sha256').update(content).digest('hex')
  }

  /** Base system prompt (extra/instructions.md). */
  getFull() {
    return this.getExtra('instructions')
  }

  /**
   * instructions.md + agent.md, for no-prompt-limit providers (Claude, Qwen)
   * that inline agent.md instead of using the $agent trigger.
   * Strips instructions.md's <memory> stub — agent.md's memory replaces it.
   */
  getUnlimited() {
    const memory = this.getExtra('agent').content
    const content = this.getExtra('instructions').content.replace(
      /<memory>.*?<\/memory>\n?/s,
      memory,
    )
    return { content, hash: this._sha(content) }
  }

  /**
   * Lazy-load a skill fragment from engine/extra/<name>.md.
   * Cached per name; hash is of the exact content returned.
   */
  getExtra(name) {
    let entry = this._skills[name]
    if (!entry) {
      const content = fs.readFileSync(path.join(EXTRA_DIR, `${name}.md`), 'utf8')
      entry = { content, hash: this._sha(content) }
      this._skills[name] = entry
    }
    return entry
  }

  /**
   * List every prompt-payload file in engine/extra/*.md (basename without extension).
   * Consumed by triggers.js to auto-register one passthrough trigger per file.
   */
  list() {
    return fs
      .readdirSync(EXTRA_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
  }
}

module.exports = new Instructions()
