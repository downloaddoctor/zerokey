// IDEToolSurface — base class for one IDE/tool surface (vscode, copilot,
// terax, opencode). Each IDE is a *configured instance* of this class, produced
// by a config function (see ./vscode.js, ./copilot.js, ./terax.js,
// ./opencode.js) that sets config fields and calls this.tool(...)/this.format(...).
//
// getIDEMapper(ide) (see ./index.js) creates the instance, applies the IDE's
// config function, and returns resolve() — the exact { tools, reverseMap,
// rawUser, system, user, tool } shape consumed by engine/compiler.js.

const fs = require('fs')
const { specs } = require('./specs')

const zero = () => null

function editToolOutputFormatter(s) {
  s = s.replaceAll(
    'String replacement failed: Could not find matching text to replace. Try making your search string more specific or checking for whitespace/formatting differences.',
    'ERROR: No matching text found in file.',
  )
  s = s.replaceAll(
    'String replacement failed: Input and output are identical',
    'ERROR: Input and output are identical',
  )
  s = s.replaceAll(/The following files were successfully edited:\n([^\n]*)/gm, 'UPDATED: $1')
  s = s.replaceAll(
    /ERROR: Your input to the tool was invalid \(must have required property '([^']+)'\)\n Please check your input and try again\./gm,
    'ERROR: Invalid parameters — missing required field.',
  )
  s = s.replaceAll(/File does not exist: ([^.]+).*\n/gm, 'ERROR: File not exist - $1')
  return s
}

const DEFAULT_FORMATTERS = {
  replace: editToolOutputFormatter,
  write: (s) =>
    s.replaceAll(/The following files were successfully edited:\n([^\n]*)/gm, 'WRITTEN: $1'),
  grep: (s) => (s.startsWith('No matches found') ? 'No matches.' : s),
  todos_add: (s) => (s.startsWith('Successfully wrote todo list') ? 'UPDATED' : s),
  todos_set: (s) => (s.startsWith('Successfully wrote todo list') ? 'UPDATED' : s),
  read: (s) => {
    if (s.startsWith('ERROR while calling tool: cannot open file')) {
      const fileLoc = s.match(/Detail: Unable to read file '([^']+)/)
      return `ERROR: File not exist - ${fileLoc[1]}`
    }
    return s
  },
  ask: (s) => {
    try {
      const answers = JSON.parse(s).answers.question
      return answers.skipped
        ? 'NO ANSWER'
        : [answers.selected[0], answers.freeText].filter(Boolean).join('\n')
    } catch {
      return s
    }
  },
  cmd: (s) => {
    if (s.endsWith('Command produced no output')) return '[OUTPUT: empty]'
    if (s.startsWith('[Output too large')) {
      const nl = s.indexOf('\n')
      const firstLine = nl === -1 ? s : s.slice(0, nl)
      const filePath = firstLine.match(/Full output saved to: (.*)\]/i)
      if (filePath) {
        try {
          return fs.readFileSync(filePath[1], 'utf-8')
        } catch {
          return `[LARGE OUTPUT] read → ${filePath[1]}`
        }
      }
    }
    if (s.startsWith('Large tool result ')) {
      const nl = s.indexOf('\n')
      const firstLine = nl === -1 ? s : s.slice(0, nl)
      const filePath = firstLine.match(/access the content at: (.*)/i)
      if (filePath) {
        try {
          return fs.readFileSync(filePath[1], 'utf-8')
        } catch {
          return `[LARGE OUTPUT] read → ${filePath[1]}`
        }
      }
    }
    s = s.replace(
      /Note: The tool simplified the command to `(.*)` \(terminal ID=.*\n/m,
      '[RAN] $1\n',
    )
    s = s.replace(
      /Note: The user manually edited the command to `(.*)` \(terminal ID=.*\n/m,
      '[RAN][MODIFIED] $1\n',
    )
    if (s.startsWith('[Output compressed'))
      return s.replace(/\[Output compressed[^\]]*\]/, '[OUTPUT COMPRESSED]').trim()
    s = s.replace(
      /Note: This terminal execution was moved to the background using the ID (.*)\n[\S\s]+/m,
      '[BACKGROUND] RUNNING IN [$1], will notify on completion.',
    )
    s = s.replace(
      /Note: The command is running in terminal ID (.*)\n[\S\s]+/m,
      '[BACKGROUND] RUNNING IN [$1], will notify on completion.',
    )
    return s
  },
  cmd_bg: (s) =>
    s.replace(
      /Command is running in terminal with ID=(.*)\n[\S\s]+/m,
      '[BACKGROUND] RUNNING IN [$1], will notify on completion.',
    ),
}

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
    this.tools = {}
    this.formatters = { ...DEFAULT_FORMATTERS }

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
      rawUser: this.rawUser,
      system: this.system,
      user: this.user,
      tool: this.formatToolOutput,
    }
  }
}

module.exports = {
  IDEToolSurface,
  parseTags,
  getAllTags,
  filterAttachments,
  editToolOutputFormatter,
  zero,
}
