const fs = require('fs')

const NEW_SESSION_START_LENGTH = {
  terax: 2,
  vscode: 3,
  opencode: 3,
}

const TAG_REGEX = /<(\w+)[^>]*>[ \n]*([\s\S]*?)[ \n]*<\/\1>/g

function getAllTags(htmlString) {
  const tags = {}
  for (const { name, content, full } of parseTags(htmlString)) {
    tags[name] = { content, full }
  }
  return { ...tags, _len: Object.keys(tags).length }
}

function getAllTagsArray(htmlString) {
  return [...parseTags(htmlString)]
}

function* parseTags(htmlString) {
  TAG_REGEX.lastIndex = 0
  let match
  while ((match = TAG_REGEX.exec(htmlString)) !== null) {
    yield { name: match[1], content: match[2], full: match[0] }
  }
}

const IDES_PROMPT_OPTIMIZER = {
  vscode: {
    rawUser: (content) => {
      const tags = getAllTags(content?.[0]?.text || content)
      return tags._len ? tags.userRequest?.content || '' : content
    },
    user: (content, messages, isNewSession) => {
      const tags = getAllTags(content?.[0].text || content)
      let userText = tags._len ? tags.userRequest?.content || '' : content
      const mes = []

      if (tags.workspace_info) {
        console.info('\n\n[SESSION] NEW STARTED!')
        const [, , cwd, , , ...struct] = tags.workspace_info.full.split('\n')

        // const hasWorkspace = userText.includes('$workspace')
        // if (hasWorkspace) {
        //   userText = userText.replace('$workspace ', '')
        //   struct.pop()
        //   struct.pop()
        //   struct.pop()
        //   mes.push(`<WORKSPACE>${struct.join('\n')}</WORKSPACE>`)
        // }

        mes.push(`<cwd>${cwd.split(' ')[1]}</cwd>`)

        return mes.filter((e) => e).join('\n\n')
      }

      if (tags.attachments?.content?.length) {
        mes.push(tags.attachments.full)
      }

      mes.push('USER: ' + (isNewSession ? 'FIRST MESSAGE - ' : '') + userText)

      return mes.filter((e) => e).join('\n\n')
    },
    tool: (name, result) => {
      try {
        const parsed = JSON.parse(result)
        if (Array.isArray(parsed)) {
          return (
            parsed
              .filter((item) => !item.mimeType)
              .map((item) => item.value || item.data || '')
              .filter((item) => item)
              .map((item) => shortenToolOutput(name, item))
              .join('') || shortenToolOutput(name, result)
          )
        }
      } catch {}
      return shortenToolOutput(name, result)
    },
  },
  terax: {
    rawUser: (content) => {
      const envClose = content.indexOf('</env>')
      if (envClose !== -1) return content.slice(envClose + 6).trim() // 6 = '</env>'.length
      return content.trim()
    },
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
    rawUser: (content) => (typeof content === 'string' ? content : content?.[0]?.text || ''),
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
            console.warn('[WRITE] DELETE:', internal.path)
            fs.unlinkSync(internal.path)
          }
        } catch {}
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
  ask: {
    desc: 'Ask the user a clarifying question. The ONLY way to request clarification — never plain text.',
    grammar: 'question={str}',
    eg: [{ question: 'Which port should the server listen on?' }],
    repeatable: { option: true, default: true },
    vscode: {
      tool: 'vscode_askQuestions',
      params: { question: 'question' },
      array: {
        key: 'options',
        fields: {
          option: 'label',
          default: 'recommended',
        },
      },
      default: { question: '', options: [] },
      transform: (values, internal) => {
        values.questions = [
          {
            header: 'question',
            question: values.question || '',
            options: values.options,
          },
        ]

        delete values.question
        delete values.options
      },
    },
    terax: {
      tool: 'bash_run',
      params: { run: 'command' },
      default: { command: 'echo "User question:"' },
      transform: (values, internal) => {
        values.command = `echo "[ASK] ${internal.question || ''}"`
      },
    },
    opencode: {
      tool: 'question',
      params: {},
      default: { questions: [] },
      transform: (values, internal) => {
        values.questions = [{ header: 'Question', question: internal.question || '', options: [] }]
      },
    },
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
    desc: 'Search file contents. query=text|regex. ?regex=true for regex. ?glob=file glob filter. ?max caps.',
    grammar: 'query={str|regex}|(regex={bool})?|(glob={regex})?|(max={0-200})?',
    eg: [{ query: 'search*', regex: true, glob: 'src/**', max: 20 }],
    keys: { query: ' ', queryR: ' ', regex: true, glob: ' ', path: ' ', max: 200 },
    transformer: (params) => {
      if (params.path) {
        params.glob = params.path
      }

      if (params.query) {
        params.regex = false
      }

      if (params.queryR) {
        params.query = params.queryR
        params.regex = true

        delete params.queryR
      }

      delete params.path
    },
    vscode: {
      tool: 'grep_search',
      params: {
        query: 'query',
        regex: 'isRegexp',
        max: 'maxResults',
        glob: 'includePattern',
        path: 'includePattern',
      },
      default: { query: ' ', isRegexp: true },
    },
    terax: {
      tool: 'grep',
      params: { query: 'pattern' },
      default: { pattern: ' ' },
    },
    opencode: {
      tool: 'grep',
      params: { query: 'pattern', glob: 'include', path: 'include' },
      default: { pattern: ' ' },
    },
  },
  cmd: {
    desc: 'Run shell command. ?till=timeout secs (0-300).',
    grammar: 'run={str}|(till={0-300})?',
    eg: [{ run: 'npm install' }, { run: 'npm test', till: 60 }],
    repeatable: { run: true, till: true },
    vscode: {
      split: true,
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
      },
    },
    terax: {
      split: true,
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
      split: true,
      tool: 'bash',
      params: { run: 'command', till: 'timeout', desc: 'description' },
      default: { command: ' ', description: ' ' },
      transform: (values, internal) => {
        if (internal.till) {
          values.timeout = internal.till * 1000
        }
      },
    },
  },

  cmd_bg: {
    desc: 'Start a shell command detached in the background. Returns a termId immediately, no output wait.',
    grammar: 'run={str}',
    eg: [{ run: 'npm run dev' }],
    vscode: {
      tool: 'run_in_terminal',
      params: { run: 'command' },
      default: {
        command: ' ',
        timeout: 1000,
        mode: 'async',
        isBackground: true,
        goal: 'Run in background',
        explanation: 'Run in background',
      },
    },
    terax: {
      tool: 'bash_background',
      params: { run: 'command' },
      default: { command: ' ' },
    },
    opencode: {
      tool: 'bash',
      params: { run: 'command' },
      default: { description: 'Start background process' },
      transform: (values, internal) => {
        values.command = `Start-Process powershell -ArgumentList '-NoProfile','-Command',"${internal.run}" -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id`
      },
    },
  },
  cmd_poll: {
    desc: 'Fetch output/status of a cmd_bg (or timed-out cmd) terminal by id',
    grammar: 'termId={str}|(tail={int})?',
    eg: [{ termId: 'abc-123' }, { termId: 'abc-123', tail: 100 }],
    keys: { termId: ' ', tail: 80 },
    vscode: {
      tool: 'get_terminal_output',
      params: { termId: 'id' },
      default: { id: ' ' },
    },
    terax: {
      tool: 'bash_logs',
      params: { termId: 'handle' },
      default: { handle: 0 },
      transform: (values, internal) => {
        values.handle = parseInt(internal.termId, 10) || 0
      },
    },
    opencode: {
      tool: 'bash',
      params: { termId: 'command' },
      default: { description: 'Check background process output' },
      transform: (values, internal) => {
        values.command = `Get-Process -Id ${internal.termId} -ErrorAction SilentlyContinue`
      },
    },
  },
  errors: {
    desc: 'Get compile/lint errors. all=true gets errors for all files (path ignored). vscode only — no cross-IDE fallback (lint setup varies per project).',
    grammar: 'all={bool}|(path={str})?',
    eg: [{ all: true }, { all: false, path: '/path/to/file.ts' }],
    keys: { all: ' ', path: ' ' },
    vscode: {
      tool: 'get_errors',
      params: {},
      default: { filePaths: [] },
      transform: (values, internal) => {
        if (!internal.all && internal.path) values.filePaths = [internal.path]
      },
    },
  },
  fetch: {
    desc: 'Fetch main content from a URL. ?query focuses extraction on relevant content (vscode only).',
    grammar: 'url={str}|(query={str})?',
    eg: [{ url: 'https://example.com' }, { url: 'https://example.com', query: 'pricing details' }],
    keys: { url: ' ', query: ' ' },
    vscode: {
      tool: 'fetch_webpage',
      params: { url: 'urls', query: 'query' },
      default: { urls: [], query: ' ' },
      transform: (values, internal) => {
        values.urls = [internal.url]
      },
    },
    terax: {
      tool: 'bash_run',
      params: { url: 'command' },
      default: { command: ' ' },
      transform: (values, internal) => {
        values.command = `Invoke-WebRequest -Uri "${internal.url}" -UseBasicParsing | Select-Object -ExpandProperty Content`
      },
    },
    opencode: {
      tool: 'webfetch',
      params: { url: 'url' },
      default: { format: 'markdown' },
    },
  },
  cmd_kill: {
    desc: 'Terminate a cmd_bg (or async) terminal by id. Idempotent.',
    grammar: 'termId={str}',
    eg: [{ termId: 'abc-123' }],
    vscode: {
      tool: 'kill_terminal',
      params: { termId: 'id' },
      default: { id: ' ' },
    },
    terax: {
      tool: 'bash_kill',
      params: { termId: 'handle' },
      default: { handle: 0 },
      transform: (values, internal) => {
        values.handle = parseInt(internal.termId, 10) || 0
      },
    },
    opencode: {
      tool: 'bash',
      params: { termId: 'command' },
      default: { description: 'Kill background process' },
      transform: (values, internal) => {
        values.command = `Stop-Process -Id ${internal.termId} -Force -ErrorAction SilentlyContinue`
      },
    },
  },

  // View Image Tool (IDE-specific: opens image in IDE's image viewer)
  view_image: {
    desc: 'View image file in IDE. Use for png, jpg, jpeg, gif, webp.',
    grammar: 'path={str}',
    eg: [{ path: '/absolute/path/to/image.png' }],
    vscode: {
      tool: 'view_image',
      params: { path: 'filePath' },
    },
  },

  todos_add: {
    desc: 'Add new tasks to the todo list. Provide id, title, status, optional desc. Use only when 3+ tools needed.',
    grammar: '({id={1-99}|title={str:10-50}|desc={str:0-500}})+',
    eg: [
      { id: 1, title: 'Scaffold auth module', status: 'active' },
      { id: 2, title: 'Write tests', status: 'wait' },
    ],
    repeatable: { id: true, title: true, status: true, desc: true },
    transformer: (params) => {
      params.$array = params.$array.map((e) => ({ ...e, status: 'wait' }))
    },
    ...TODO(),
  },
  todos_set: {
    desc: 'Update status of existing tasks. id + status only. Server merges with retained list.',
    grammar: '({id={1-99}|status={active|done}})+',
    eg: [
      { id: 1, status: 'done' },
      { id: 2, status: 'active' },
    ],
    repeatable: { id: true, status: true, title: true, desc: true },
    ...TODO(),
  },
}

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

const SHORTENERS = {
  view_image: (s) => s,
  replace: editToolOutputFormatter,
  write: (s) => {
    return s.replaceAll(/The following files were successfully edited:\n([^\n]*)/gm, 'WRITTEN: $1')
  },
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
  cmd_bg: (s) => {
    s = s.replace(
      /Command is running in terminal with ID=(.*)\n[\S\s]+/m,
      '[BACKGROUND] RUNNING IN [$1], will notify on completion.',
    )

    return s
  },
}

/**
 * Shorten verbose IDE tool output to concise messages.
 */
function shortenToolOutput(name, output) {
  let s = String(output).trim()
  const fn = SHORTENERS[name]

  s = s.replace(
    'The user chose to skip the tool call, they want to proceed without running it\n',
    '[SKIPPED BY USER]',
  )
  s = s.replace('The user cancelled the tool call.', '[CANCELLED BY USER]')

  if (fn) return fn(s)

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
