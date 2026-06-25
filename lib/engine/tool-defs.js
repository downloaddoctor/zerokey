const fs = require('fs')

const NEW_SESSION_START_LENGTH = {
  terax: 2,
  vscode: 3,
  opencode: 3,
}

function getAllTags(htmlString) {
  const regex = /<(\w+)[^>]*>[ \n]*([\s\S]*?)[ \n]*<\/\1>/g
  const tags = {}
  let match

  while ((match = regex.exec(htmlString)) !== null) {
    tags[match[1]] = { content: match[2], full: match[0] }
  }

  return tags
}

function getAllTagsArray(htmlString) {
  const regex = /<(\w+)[^>]*>[ \n]*([\s\S]*?)[ \n]*<\/\1>/g
  const tags = []
  let match

  while ((match = regex.exec(htmlString)) !== null) {
    tags.push({ name: match[1], content: match[2], full: match[0] })
  }

  return tags
}

const IDES_PROMPT_OPTIMIZER = {
  vscode: {
    user: (prefix, content, messages, isNewSession) => {
      // fs.writeFile('temp/' + Date.now() + '-rcr.json', JSON.stringify(messages, null, 1), () => {})

      const current = getAllTags(content?.[0].text || content)
      const mes = []
      if (messages.length == NEW_SESSION_START_LENGTH.vscode) {
        console.info('\n\n[SESSION] NEW STARTED!')
        const mesContent = messages[1].content
        const session = getAllTags(typeof mesContent === 'string' ? mesContent : mesContent[0].text)

        // if (isNewSession) {
        //   mes.push(session.workspace_info?.full)
        //   mes.push(session.environment_info?.full)
        // } else {
        const [, , cwd] = session.workspace_info?.full.split('\n')
        mes.push(`SYSTEM: OS: Windows\nSHELL: PowerShell\nCWD: ${cwd.split(' ')[1]}`)
        // }
      }

      if (current.attachments) {
        const attachments = getAllTagsArray(current.attachments.content)
        mes.push(attachments[0].full)
      }

      mes.push(
        'USER: ' +
          (isNewSession ? 'FIRST MESSAGE - ' : '') +
          (current.userRequest?.content || content),
      )

      return mes.filter((e) => e).join('\n\n')
    },
    tool: (name, result) => {
      try {
        const parsed = JSON.parse(result)
        if (Array.isArray(parsed)) {
          return shortenToolOutput(
            name,
            parsed
              .filter((item) => !item.mimeType)
              .map((item) => item.value || item.data || '')
              .join('') || result,
          )
        }
      } catch {}
      return shortenToolOutput(name, result)
    },
  },
  terax: {
    user: (prefix, content, messages) => {
      if (messages.length <= NEW_SESSION_START_LENGTH.terax) {
        console.info('\n\n[SESSION] NEW STARTED!')
        return content
      }

      const envClose = content.indexOf('</env>')
      if (envClose !== -1) {
        // Everything after </env> is the user message
        return content.slice(envClose + 6).trim() // 6 = '</env>'.length
      }

      return content.trim()
    },
    tool: (result) => result,
  },
  opencode: {
    user: (prefix, content, messages) => {
      if (messages.length <= NEW_SESSION_START_LENGTH.opencode) {
        console.info('\n\n[SESSION] NEW STARTED!')
      }
      return prefix + (typeof content === 'string' ? content : content?.[0]?.text || '')
    },
    tool: (result) => result,
  },
}

// Shared todo IDE mappings (used by both todoAdd and todo)
const TODO = () => ({
  vscode: {
    tool: 'manage_todo_list',
    params: {},
    array: {
      key: 'todoList',
      fields: {
        id: 'id',
        title: 'title',
        status: {
          wait: 'not-started',
          active: 'in-progress',
          done: 'completed',
        },
        desc: 'description',
      },
    },
    default: { todoList: [] },
  },
  terax: {
    tool: 'todo_write',
    params: {},
    array: {
      key: 'todos',
      fields: {
        id: 'id',
        title: 'title',
        status: {
          wait: 'pending',
          active: 'in_progress',
          done: 'completed',
        },
        desc: 'description',
      },
    },
    default: { todos: [] },
    transform: (values) => {
      values.todos.forEach((todo) => {
        todo.id = todo.id + ''
      })
      return values
    },
  },
  opencode: {
    tool: 'todowrite',
    params: {},
    array: {
      key: 'todos',
      fields: {
        title: 'content',
        status: {
          wait: 'pending',
          active: 'in_progress',
          done: 'completed',
        },
        desc: 'description',
      },
    },
    default: { todos: [] },
    transform: (values) => {
      values.todos.forEach((todo) => {
        todo.priority = 'high'
      })
      return values
    },
  },
})

const EDIT = () => ({
  vscode: {
    tool: 'multi_replace_string_in_file',
    params: {},
    array: {
      key: 'replacements',
      fields: {
        path: 'filePath',
        old: 'oldString',
        new: 'newString',
      },
    },
    default: { replacements: [], explanation: 'Multiple string replacement in the file' },
  },
  terax: {
    split: true,
    tool: 'edit',
    params: {
      path: 'path',
      old: 'old_string',
      new: 'new_string',
    },
  },
  opencode: {
    split: true,
    tool: 'edit',
    params: {
      path: 'filePath',
      old: 'oldString',
      new: 'newString',
    },
  },
})

// --- Core tools ---
const TOOLS = {
  read: {
    desc: 'Read file → content',
    grammar: 'path={str}|(from={1-10000}|to={1-10000})?',
    eg: [{ path: '/path/to/file.txt' }, { path: '/path/to/file.txt', from: 1, to: 10 }],
    transformer: (params) => {
      if (params.from) {
        params.offset = params.from - 1
        params.limit = Math.max(params.to - params.from + 1, 1)
      }
    },
    keys: { from: true, to: true },
    vscode: {
      tool: 'read_file',
      params: { path: 'filePath', from: 'startLine', to: 'endLine' },
      default: { filePath: ' ', startLine: 1, endLine: 10_000 },
    },
    terax: {
      tool: 'read_file',
      params: { path: 'path', offset: 'offset', limit: 'limit' },
    },
    opencode: {
      tool: 'read',
      params: { path: 'filePath', offset: 'offset', limit: 'limit' },
    },
  },
  write: {
    desc: 'Create/overwrite file. path → file. content → full body.',
    grammar: 'path={str}|content={str}',
    eg: [{ path: '/path/to/file.txt', content: 'whole file content here' }],
    vscode: {
      tool: 'create_file',
      params: { path: 'filePath', content: 'content' },
      transform: (values, internal) => {
        try {
          if (fs.existsSync(internal.path)) {
            console.log('[WRITE] DELETE:', internal.path)
            fs.unlinkSync(internal.path)
          }
        } catch {}
        values.content = internal.content || ''
        return values
      },
    },
    terax: {
      tool: 'write_file',
      params: { path: 'path', content: 'content' },
    },
    opencode: {
      tool: 'write',
      params: { path: 'filePath', content: 'content' },
    },
  },

  // Edit Tools
  replace: {
    desc: 'Exact string swap. Supports multiple edits across one or more files in one call.',
    grammar: '(path={str}|old={str}|new={str})+',
    eg: [
      {
        path: '/path/to/file.txt',
        old: 'const name = "old"',
        new: 'const name = "new"',
      },
    ],
    repeatable: { path: true, old: true, new: true },
    ...EDIT(),
  },
  patch: {
    desc: 'Apply a diff-style patch to a file. Lines starting with - are removed, + are added, space lines are context (ignored). Multiple @@ blocks supported.',
    grammar: 'path={str}|diff={str}',
    eg: [
      {
        path: '/path/to/file.js',
        diff: '+alpha\n beta\n@@\n gamma\n+delta\n@@\n-0,1\n+0\n+1\n 2',
      },
    ],
    keys: { path: true, diff: ' ' },
    transformer: (params) => {
      // Parse diff string into old/new blocks separated by @@ markers
      const raw = params.diff || ''
      const blocks = raw
        .split(/^@@[^\n]*$/m)
        .map((b) => b.trim())
        .filter(Boolean)

      const parseBlock = (block) => {
        const lines = block.split('\n')
        const oldLines = []
        const newLines = []
        for (const line of lines) {
          if (line.startsWith('-')) {
            oldLines.push(line.slice(1))
          } else if (line.startsWith('+')) {
            newLines.push(line.slice(1))
          } else {
            // context line — goes into BOTH old and new (unchanged)
            const ctx = line.startsWith(' ') ? line.slice(1) : line
            oldLines.push(ctx)
            newLines.push(ctx)
          }
        }
        return { old: oldLines.join('\n'), new: newLines.join('\n') }
      }

      const allBlocks = blocks.length === 0 ? [raw] : blocks
      params.$array = allBlocks.map((b) => ({ path: params.path, ...parseBlock(b) }))
      console.log('[PATCH]', params.$array)
    },
    ...EDIT(),
  },
  // ⟦chunk¦path={abs}¦diff={str}⟧ — like patch but character-level, single line: just `@@` splits hunks, `~` context chars anchor & stay, `-` chars found in line & removed, `+` chars inserted there or at `~` if no `-`; add `~` only when `-` isn't unique/absent, never put `-` inside `~`.
  charPatch: {
    desc: 'Patch a substring within a single line. Same @@ diff syntax as linePatch, but operates within one line: - fragments are removed, + fragments are added, space fragments are kept in both. Fragments are concatenated in order to build old/new for that line.',
    grammar: 'path={str}|diff={str}',
    eg: [
      {
        path: '/path/to/file.js',
        diff: ' const PORT = \n-8000\n+5000',
      },
      {
        path: '/path/to/file.js',
        diff: '+prepended\n-hello\n world',
      },
    ],
    keys: { path: true, diff: ' ' },
    transformer: (params) => {
      const raw = params.diff || ''
      const blocks = raw
        .split(/^@@[^\n]*$/m)
        .map((b) => b.trim())
        .filter(Boolean)

      const parseBlock = (block) => {
        const lines = block.split('\n')
        let oldStr = ''
        let newStr = ''

        for (const line of lines) {
          if (line.startsWith('-')) {
            oldStr += line.slice(1)
          } else if (line.startsWith('+')) {
            newStr += line.slice(1)
          } else {
            const ctx = line.startsWith(' ') ? line.slice(1) : line
            oldStr += ctx
            newStr += ctx
          }
        }

        return { old: oldStr, new: newStr }
      }

      const allBlocks = blocks.length === 0 ? [raw] : blocks
      params.$array = allBlocks.map((b) => ({ path: params.path, ...parseBlock(b) }))
      console.log('[CHARPATCH]', params.$array)
    },
    ...EDIT(),
  },
  ls: {
    desc: 'List dir children. Files + subdirs. Subdirs end with /.',
    grammar: 'path={str}',
    eg: [{ path: '/path/to/directory' }],
    vscode: {
      tool: 'list_dir',
      params: { path: 'path' },
      default: { path: true },
    },
    terax: {
      tool: 'list_directory',
      params: { path: 'path' },
      default: { path: true },
    },
    opencode: {
      tool: 'read',
      params: { path: 'filePath' },
      default: { filePath: ' ' },
    },
  },
  mkdir: {
    desc: 'mkdir -p. Creates dir + missing parents.',
    grammar: 'path={str}',
    eg: [{ path: '/path/to/new/directory' }],
    vscode: {
      tool: 'create_directory',
      params: { path: 'dirPath' },
      default: { dirPath: ' ' },
    },
    terax: {
      tool: 'create_directory',
      params: { path: 'path' },
      default: { path: ' ' },
    },
    opencode: {
      tool: 'bash',
      params: { path: 'command' },
      default: { command: ' ', description: 'Create directory' },
      transform: (values, internal) => {
        values.command = `New-Item -ItemType Directory -Force -Path "${internal.path}"`
        return values
      },
    },
  },
  glob: {
    desc: 'Find files by glob pattern. ?max caps results (0-200).',
    grammar: 'pattern={str}|(max={0-200})?',
    eg: [{ pattern: '**/*.js' }],
    keys: { pattern: ' ', max: 200 },
    vscode: {
      tool: 'file_search',
      params: { pattern: 'query', max: 'maxResults' },
      default: { query: ' ' },
    },
    terax: {
      tool: 'glob',
      params: { pattern: 'pattern' },
      default: { pattern: ' ' },
    },
    opencode: {
      tool: 'glob',
      params: { pattern: 'pattern' },
      default: { pattern: ' ' },
    },
  },
  grep: {
    desc: 'Search file contents. query=text|regex. ?regex=true for regex. ?path=file glob filter. ?max caps.',
    grammar: 'query={str|regex}|(regex={bool})?|(path={regex})?|(max={0-200})?',
    eg: [{ query: 'search*', regex: true, path: 'src/**', max: 20 }],
    keys: { query: ' ', regex: true, path: ' ', max: 200 },
    vscode: {
      tool: 'grep_search',
      params: {
        query: 'query',
        path: 'includePattern',
        regex: 'isRegexp',
        max: 'maxResults',
      },
      default: { query: ' ', isRegexp: false },
    },
    terax: {
      tool: 'grep',
      params: { query: 'pattern' },
      default: { pattern: ' ' },
    },
    opencode: {
      tool: 'grep',
      params: { query: 'pattern', path: 'include' },
      default: { pattern: ' ' },
    },
  },
  cmd: {
    desc: 'Run shell command. ?till=timeout secs (0-300).',
    grammar: 'run={str}|(till={0-300})?',
    eg: [{ run: 'npm install' }, { run: 'npm test', till: 60 }],
    vscode: {
      tool: 'run_in_terminal',
      params: {
        run: 'command',
        till: 'timeout',
        goal: 'goal',
        desc: 'explanation',
      },
      default: {
        command: ' ',
        mode: 'sync',
        isBackground: false,
        goal: ' ',
        explanation: ' ',
      },
      transform: (values, internal) => {
        if (internal.till) {
          values.timeout = internal.till * 1000
        }
        return internal
      },
    },
    terax: {
      tool: 'bash_run',
      params: {
        run: 'command',
        till: 'timeout_secs',
        goal: 'goal',
        desc: 'desc',
      },
      default: { command: ' ' },
    },
    opencode: {
      tool: 'bash',
      params: { run: 'command', till: 'timeout', desc: 'description' },
      default: { command: ' ', description: ' ' },
      transform: (values, internal) => {
        if (internal.till) {
          values.timeout = internal.till * 1000
        }
        return values
      },
    },
  },

  'todo+': {
    desc: 'Add new tasks to the todo list. Provide id, title, status, optional desc. Use only when 3+ tools needed.',
    grammar: '({id={1-99}|title={str:10-50}|status={wait|active|done}|desc={str:0-500}})+',
    eg: [
      { id: 1, title: 'Scaffold auth module', status: 'active' },
      { id: 2, title: 'Write tests', status: 'wait' },
    ],
    repeatable: { id: true, title: true, status: true, desc: true },
    ...TODO(),
  },
  'todo!': {
    desc: 'Update status of existing tasks. id + status only. Server merges with retained list.',
    grammar: '({id={1-99}|status={wait|active|done}})+',
    eg: [
      { id: 1, status: 'done' },
      { id: 2, status: 'active' },
    ],
    repeatable: { id: true, status: true, title: true, desc: true },
    ...TODO(),
  },
}

const zero = () => null
const EDIT_TOOLS = {
  charPatch: true,
  replace: true,
  patch: true,
}

/**
 * Shorten verbose IDE tool output to concise messages.
 */
function shortenToolOutput(name, output) {
  const s = String(output).trim()

  if (EDIT_TOOLS[name]) {
    if (s.startsWith('String replacement failed')) return 'No match — text not found in file.'
    if (s.includes('must have required property'))
      return 'Invalid parameters — missing required field.'
    const editedMatch = s.match(/successfully edited:\s*\n\s*(.+)/)
    if (editedMatch) return `Updated ${editedMatch[1].split(/[\\/]/).pop()}`
  }

  if (name == 'grep') if (s.startsWith('No matches found')) return 'No matches.'
  if (name === 'todo+' || name === 'todo!') {
    if (s.startsWith('Successfully wrote todo list')) {
      return 'Updated'
    }
  }
  if (name == 'cmd') {
    if (s.startsWith('\n\nCommand produced no output')) return '[NO OUTPUT]'
    if (s.startsWith('Large tool result')) {
      const largeMatch = s.match(/written to file[.\s\S]*?content at:\s*(.+?\.txt)\)/)
      if (largeMatch) return `[LARGE OUTPUT] → ${largeMatch[1]}`
    }

    if (s.startsWith('[Output compressed'))
      return s
        .replace(/\[Output compressed[^\]]*\]/, '[OUTPUT COMPRESSED]')
        .replace(/terminal ID=[^\\)]+\)?/, '')
        .replace(/\s*Note:.*$/, '')
        .trim()
    if (s.includes('simplified the command')) return s.replace(/\(terminal ID=[^)]+\)/, '').trim()
  }

  return s
}

/**
 * Given an IDE name, returns:
 *   1. A prompt-ready string with grammar + examples for all tools
 *   2. A resolved tools object mapping toolName → IDE-specific config
 *
 * @param {string} ide - 'vscode' | 'terax' | 'opencode'
 * @returns {{ prompt: string, tools: object }}
 */
function getIDEMapper(ide) {
  const resolved = {}

  for (const [toolName, tool] of Object.entries(TOOLS)) {
    const mapping = tool[ide]
    if (!mapping) continue

    mapping.keys = tool.keys ?? {}
    mapping.default = mapping.default ?? {}
    mapping.transformer = tool.transformer ?? zero

    mapping.transform = mapping.transform ?? zero
    Object.assign(mapping.keys, mapping.params)

    // Build resolved command entry
    if (tool.repeatable) {
      mapping.repeatable = tool.repeatable
      Object.assign(mapping.keys, tool.repeatable)
    }

    resolved[toolName] = mapping
  }

  // Build reverse map: IDE tool name → generic tool name
  const reverseMap = {}
  for (const [genericName, ideConfig] of Object.entries(resolved)) {
    reverseMap[ideConfig.tool] = genericName
  }

  return {
    tools: resolved,
    reverseMap,
    ...IDES_PROMPT_OPTIMIZER[ide],
  }
}

const TOOL_OUTPUT_LIMITS = {
  claude: 64_000,
  chatgpt: 64_000,
  deepseek: Infinity,
}

module.exports = { TOOLS, getIDEMapper, TOOL_OUTPUT_LIMITS }
