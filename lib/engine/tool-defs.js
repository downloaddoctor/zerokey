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

        if (isNewSession) {
          mes.push(session.workspace_info?.full)
          mes.push(session.environment_info?.full)
        } else {
          const [, , cwd] = session.workspace_info?.full.split('\n')
          mes.push(`OS: Windows\nSHELL: PowerShell\nCWD: ${cwd.split(' ')[1]}`)
        }
      }

      if (current.attachments) {
        const attachments = getAllTagsArray(current.attachments.content)
        mes.push(attachments[0].full)
      }

      mes.push((isNewSession ? 'FIRST MESSAGE: ' : '') + (current.userRequest?.content || content))

      return mes.filter((e) => e).join('\n\n')
    },
    tool: (result) => {
      try {
        const parsed = JSON.parse(result)
        // console.log(result, parsed)
        if (Array.isArray(parsed)) {
          return (
            parsed
              .filter((item) => !item.mimeType)
              .map((item) => item.value || item.data || '')
              .join('') || result
          )
        }
      } catch {}
      return result
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
    tool: (result) => {
      try {
        const parsed = JSON.parse(result)
        if (Array.isArray(parsed)) {
          return (
            parsed
              .filter((item) => !item.mimeType)
              .map((item) => item.value || item.data || '')
              .join('') || result
          )
        }
      } catch {}
      return result
    },
  },
}

const RAW_EDIT = () => ({
  vscode: {
    tool: 'replace_string_in_file',
    params: { path: 'filePath', old: 'oldString', new: 'newString' },
    default: { filePath: ' ', oldString: ' ', newString: ' ' },
  },
  terax: {
    tool: 'edit',
    params: {
      path: 'path',
      old: 'old_string',
      new: 'new_string',
    },
    default: {
      path: ' ',
      old_string: ' ',
      new_string: ' ',
    },
  },
  opencode: {
    tool: 'edit',
    params: { path: 'filePath', old: 'oldString', new: 'newString' },
    default: { filePath: ' ', oldString: ' ', newString: ' ' },
  },
})

function applyTransform(params, label, buildNew) {
  console.log(`[${label}]`, params)
  let content = ''
  if (fs.existsSync(params.path)) {
    content = fs.readFileSync(params.path, 'utf8')
  } else {
    fs.writeFileSync(params.path, '', 'utf8')
    console.log(`[${label}] File not found — created: ${params.path}`)
  }
  params.new = buildNew(content)
}

// Shared todo IDE mappings (used by both todoAdd and todo)
const TODO_VSCODE = () => ({
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
})

const TODO_TERAX = () => ({
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
})

const TODO_OPENCODE = () => ({
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
      default: { path: ' ' },
    },
    opencode: {
      tool: 'read',
      params: { path: 'filePath', offset: 'offset', limit: 'limit' },
      default: { filePath: ' ' },
    },
  },
  write: {
    desc: 'Create/overwrite file. path → file. content → full body.',
    grammar: 'path={str}|content={str}',
    eg: [{ path: '/path/to/file.txt', content: 'whole file content here' }],
    vscode: {
      tool: 'create_file',
      params: { path: 'filePath', content: 'content' },
      default: { filePath: ' ', content: ' ' },
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
      default: { path: ' ', content: ' ' },
    },
    opencode: {
      tool: 'write',
      params: { path: 'filePath', content: 'content' },
      default: { filePath: ' ', content: ' ' },
    },
  },

  // Edit Tools
  append: {
    desc: 'Insert content after after line. No after → EOF.',
    grammar: 'path={str}|(after={str})?|content={str}',
    keys: { path: ' ', after: ' ', content: ' ' },
    eg: [
      {
        path: '/path/to/file.txt',
        after: 'function login(user) {',
        content: '  console.log("logging in")',
      },
      {
        path: '/path/to/file.txt',
        content: 'export default app',
      },
    ],
    transformer: (params) =>
      applyTransform(params, 'APPEND', (content) => {
        const newContent = (params.content || '').replaceAll('\\n', '\n')

        params.old = params.after ? params.after : content.slice(-50)
        return params.old + '\n' + newContent
      }),
    ...RAW_EDIT(),
  },

  prepend: {
    desc: 'Insert content before before line. No before → BOF.',
    grammar: 'path={str}|(before={str})?|content={str}',
    keys: { path: ' ', before: ' ', content: ' ' },
    eg: [
      {
        path: '/path/to/file.txt',
        before: 'function login(user) {',
        content: '/**\n * Authenticate user\n */',
      },
      {
        path: '/path/to/file.txt',
        content: 'import fs from "fs"',
      },
    ],
    transformer: (params) =>
      applyTransform(params, 'PREPEND', (content) => {
        const newContent = (params.content || '').replaceAll('\\n', '\n')

        params.old = params.before ? params.before : content.substring(0, 50)
        return newContent + '\n' + params.old
      }),
    ...RAW_EDIT(),
  },
  replace: {
    desc: 'Exact string swap. Supports multiple edits across one or more files in one call.',
    grammar: '(path={str}|old={str}|new={str})+',
    repeatable: { path: true, old: true, new: true },
    eg: [
      {
        path: '/path/to/file.txt',
        old: 'const name = "old"',
        new: 'const name = "new"',
      },
    ],
    vscode: {
      tool: 'replace_string_in_file',
      params: {},
      split: true,
      array: {
        key: 'replacements',
        fields: {
          path: 'filePath',
          old: 'oldString',
          new: 'newString',
        },
      },
      default: {},
    },
    terax: {
      tool: 'edit',
      params: {},
      split: true,
      array: {
        key: 'edits',
        fields: {
          path: 'path',
          old: 'old_string',
          new: 'new_string',
        },
      },
      default: {},
    },
    opencode: {
      tool: 'edit',
      params: {},
      split: true,
      array: {
        key: 'edits',
        fields: {
          path: 'filePath',
          old: 'oldString',
          new: 'newString',
        },
      },
      default: {},
    },
  },
  replaceLines: {
    desc: 'Replace lines by line number. Multiple files/edits in one call. IMPORTANT: separate each entry with pipe not newline.',
    grammar: '(path={str}|from={num}|to={num}|new={str})+',
    repeatable: { path: true, from: true, to: true, new: true },
    eg: [{ path: '/path/to/file.txt', from: 14, to: 22, new: 'replaced block' }],
    transformer: (params) => {
      const resolveByLineNo = (entry, filePath) => {
        if (entry.from === undefined) return
        const content = fs.readFileSync(filePath, 'utf8')
        const lines = content.split('\n')
        let from = Number(entry.from) - 1 // 1-based → 0-based
        let to = entry.to !== undefined ? Number(entry.to) - 1 : from

        // from<1 (0-based: <0) → prepend mode (insert before line 1)
        if (from < 0) {
          entry.old = content.slice(0, 50)
          entry.new = (entry.new || '').replaceAll('\\n', '\n') + '\n' + entry.old
          console.log(`[replaceLines] from<=0 → prepend mode`)
          return
        }
        // clamp to beyond EOF → append mode: set old to last 50 chars so replace appends
        if (from >= lines.length) {
          entry.old = content.slice(-50)
          entry.new = entry.old + '\n' + (entry.new || '').replaceAll('\\n', '\n')
          console.log(`[replaceLines] out-of-bounds → append mode`)
          return
        }
        // clamp to to last line
        if (to >= lines.length) to = lines.length - 1
        // fix reversed range — swap instead of clamp
        if (from > to) {
          const tmp = from
          from = to
          to = tmp
        }

        entry.old = lines.slice(from, to + 1).join('\n')
        console.log(`[replaceLines] lines ${entry.from}-${entry.to} → ${entry.old.length} chars`)
      }

      if (params.$array) {
        for (const entry of params.$array) {
          resolveByLineNo(entry, entry.path)
        }
      } else {
        resolveByLineNo(params, params.path)
      }
    },
    vscode: {
      tool: 'replace_string_in_file',
      params: {},
      split: true,
      array: {
        key: 'replacements',
        fields: {
          path: 'filePath',
          old: 'oldString',
          new: 'newString',
        },
      },
      default: {},
    },
    terax: {
      tool: 'edit',
      params: {},
      split: true,
      array: {
        key: 'edits',
        fields: {
          path: 'path',
          old: 'old_string',
          new: 'new_string',
        },
      },
      default: {},
    },
    opencode: {
      tool: 'edit',
      params: {},
      split: true,
      array: {
        key: 'edits',
        fields: {
          path: 'filePath',
          old: 'oldString',
          new: 'newString',
        },
      },
      default: {},
    },
  },
  list: {
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

  todoAdd: {
    desc: 'Add new tasks to the todo list. Provide id, title, status, optional desc. Use only when 3+ tools needed.',
    grammar: '({id={1-99}|title={str:10-50}|status={wait|active|done}|desc={str:0-500}})+',
    eg: [
      { id: 1, title: 'Scaffold auth module', status: 'active' },
      { id: 2, title: 'Write tests', status: 'wait' },
    ],
    repeatable: { id: true, title: true, status: true, desc: true },
    vscode: TODO_VSCODE(),
    terax: TODO_TERAX(),
    opencode: TODO_OPENCODE(),
  },
  todo: {
    desc: 'Update status of existing tasks. id + status only. Server merges with retained list.',
    grammar: '({id={1-99}|status={wait|active|done}})+',
    eg: [
      { id: 1, status: 'done' },
      { id: 2, status: 'active' },
    ],
    repeatable: { id: true, status: true },
    vscode: TODO_VSCODE(),
    terax: TODO_TERAX(),
    opencode: TODO_OPENCODE(),
  },
}

const zero = () => null
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
