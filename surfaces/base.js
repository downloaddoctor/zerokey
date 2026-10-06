// IDEToolSurface — base class for one IDE/tool surface (vscode, copilot,
// terax, opencode). Each IDE is a *configured instance* of this class, produced
// by a config function (see ./vscode.js, ./copilot.js, ./terax.js,
// ./opencode.js) that sets config fields and calls this.tool(...)/this.format(...).
//
// getIDEMapper(ide) (see ./index.js) creates the instance, applies the IDE's
// config function, and returns resolve() — the exact { tools, reverseMap,
// rawUser, system, user, tool } shape consumed by engine/compiler.js.
const { specs } = require('./specs')

const zero = () => null

function* parseTags(htmlString) {
  const re = /<(\w+)[^>]*>[ \r\n]*([\s\S]*?)[ \r\n]*<\/\1>/g
  let match
  while ((match = re.exec(htmlString)) !== null) {
    yield { name: match[1], content: match[2], full: match[0] }
  }
}

function getAllTags(htmlString) {
  const tags = {}
  for (const { name, content, full } of parseTags(htmlString)) {
    tags[name] = { content, full }
  }
  return { ...tags, _len: Object.keys(tags).length }
}

function filterAttachments(attachmentsFull) {
  const blocks = [...parseTags(attachmentsFull)].filter((t) => t.name === 'attachment')
  if (!blocks.length) return attachmentsFull

  const hasSelection = blocks.some((b) => b.content.includes("User's active selection"))
  if (!hasSelection) return attachmentsFull

  const kept = blocks
    .filter((b) => !b.content.includes("User's active file for additional context"))
    .map((b) => b.full)

  return `<attachments>\n${kept.join('\n')}\n</attachments>`
}

class IDEToolSurface {
  constructor() {
    this.ideName = null
    this.newSessionStartLength = 0
    this.realSessionPrefix = null
    // System-prompt prefixes for IDE-internal utility calls (title-gen,
    // progress messages, summarizer, terminal quick fix, …). Each surface
    // declares its own; matched by prefix because utility prompts are short
    // and stable, unlike the real 20–30 KB IDE fingerprint.
    this.utilityPrefixes = []
    // Declarative flags consumed by engine/compiler, engine/triggers and
    // engine/mcp/inject so they never name a specific surface:
    //   browserTools     — this surface exposes the $browser/$playwright families
    //   browserNameMap   — genericKey → native browser-tool name for this surface
    this.browserTools = false
    this.browserNameMap = {}
    this.tools = {}
    this.formatters = {}

    // Prompt handlers — overridable per surface. Note: the tool *output*
    // handler is `formatToolOutput`; the `tool()` method is the registrar.
    this.rawUser = (content) => content
    this.system = () => ''
    this.user = (content, messages, isNewSession) =>
      'USER: ' + (isNewSession ? 'FIRST MESSAGE - ' : '') + content
    this.formatToolOutput = (name, result) => this.shortenToolOutput(name, result)
  }

  /**
   * Register a generic tool's native mapping for this surface.
   *
   * @param {string} generic - generic tool name (key in specs.js)
   * @param {string} native - native tool name emitted to the IDE
   * @param {object} [opts]
   * @param {object} [opts.params]      - generic field → native field
   * @param {object} [opts.default]     - default native args
   * @param {function} [opts.transform] - (nativeArgs, internalParams) => void
   * @param {object} [opts.array]       - { key, fields, transform? } repeating mapping
   * @param {boolean} [opts.split]      - emit one native call per array entry
   */
  tool(generic, native, opts = {}) {
    const spec = specs[generic]
    if (!spec) throw new Error(`Unknown generic tool: ${generic}`)

    const mapping = {
      tool: native,
      params: opts.params ?? {},
      default: opts.default ?? {},
      array: opts.array ?? null,
      split: opts.split ?? false,
      keys: Object.assign({}, spec.keys),
      transformer: spec.transformer ?? zero,
      transform: opts.transform ?? zero,
      repeatable: spec.repeatable ?? null,
    }

    Object.assign(mapping.keys, mapping.params)
    if (mapping.repeatable) Object.assign(mapping.keys, mapping.repeatable)

    this.tools[generic] = mapping
  }

  /** Register a tool-output shortener for a generic tool name. */
  format(generic, fn) {
    this.formatters[generic] = fn
  }

  /**
   * Does this system-prompt content belong to this surface? Each surface
   * declares its fingerprint via `this.realSessionPrefix` in its config.
   *
   * @param {string} content - the first (system) message content
   * @returns {boolean}
   */
  isRealSession(content) {
    return (
      typeof content === 'string' &&
      typeof this.realSessionPrefix === 'string' &&
      content.startsWith(this.realSessionPrefix)
    )
  }

  /**
   * Does this system-prompt content match an IDE-internal utility call
   * declared by this surface via `this.utilityPrefixes`? Utilities carry no
   * IDE fingerprint and may still carry tools[] — they must never write into
   * a real session.
   *
   * @param {string} content - the first (system) message content
   * @returns {string|null} the matched prefix, or null
   */
  isUtilityPrompt(content) {
    if (typeof content !== 'string') return null
    for (const prefix of this.utilityPrefixes) {
      if (typeof prefix === 'string' && prefix && content.startsWith(prefix)) {
        return prefix
      }
    }
    return null
  }

  shortenToolOutput(name, output) {
    const fn = this.formatters[name]
    return fn && typeof output === 'string' ? fn(output) : output
  }

  /** Build the resolved object consumed by ToolCompiler. */
  resolve() {
    const reverseMap = {}
    for (const [generic, cfg] of Object.entries(this.tools)) {
      reverseMap[cfg.tool] = generic
    }

    return {
      tools: this.tools,
      reverseMap,
      rawUser: this.rawUser.bind(this),
      system: this.system.bind(this),
      user: this.user.bind(this),
      tool: this.formatToolOutput.bind(this),
    }
  }
}

module.exports = {
  IDEToolSurface,
  parseTags,
  getAllTags,
  filterAttachments,
  zero,
}
