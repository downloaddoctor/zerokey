const fs = require('fs')

const NEW_SESSION_START_LENGTH = {
  vscode: 3,
  terax: 2,
  opencode: 2,
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
    user: (prefix, content, messages) => {
      // fs.writeFile(
      //   'temp/' + Date.now() + '-rcr.json',
      //   JSON.stringify(messages.slice(-3), null, 1),
      //   () => {},
      // )

      const current = getAllTags(content?.[0].text || content)
      const mes = []
      if (messages.length <= NEW_SESSION_START_LENGTH.vscode) {
        console.info('\n\n[SESSION] NEW STARTED!')
        const session = getAllTags(messages[1].content[0].text)
        mes.push(session.environment_info?.full)
        mes.push(session.workspace_info?.full)
      }

      if (current.attachments) {
        const attachments = getAllTagsArray(current.attachments.content)
        mes.push(attachments[0].full)
      }

      mes.push(current.userRequest?.content || content)

      return mes.join('\n\n')
    },
    tool: (result) => {
      try {
        const parsed = JSON.parse(result)
        if (Array.isArray(parsed)) {
          return parsed
            .filter((item) => !item.mimeType)
            .map((item) => item.value || item.data || '')
            .join('')
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
    user: (prefix, content, messages) => prefix + content,
    tool: (result) => result,
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
})

function resolveAnchors(content, anchor, label) {
  if (!anchor) return { idx: -1 }

  const resolved = anchor.replaceAll('\\n', '\n')
  const idx = content.indexOf(resolved)
  if (idx === -1) {
    console.error(`[${label}] Anchor not found - ${anchor}`)
    return { idx: -1, resolved: content }
  }
  if (content.indexOf(resolved, idx + 1) !== -1)
    console.warn(`[${label}] Anchor appears multiple times`)

  return { resolved, idx }
}

function applyTransform(params, label, buildNew) {
  console.log(`[${label}]`, params)
  const content = fs.readFileSync(params.path, 'utf8')
  params.new = buildNew(content)
}

// --- Core tools ---
const TOOLS = {
  read: {
    desc: 'Read file → content. ?offset=0‑based start line. ?limit=max lines.',
    grammar: 'path={str}|(offset={0-10000}|limit={1-10000})?',
    eg: [{ path: '/path/to/file.txt' }, { path: '/path/to/file.txt', offset: 0, limit: 10 }],
    vscode: {
      tool: 'read_file',
      params: { path: 'filePath', offset: 'startLine', limit: 'endLine' },
      default: { filePath: ' ', startLine: 1, endLine: 10_000 },
      transform: (values, internal) => {
        if (internal.offset) {
          values.startLine = internal.offset + 1
          values.endLine = values.startLine + (internal.limit || 200)
        }

        return values
      },
    },
    terax: {
      tool: 'read_file',
      params: { path: 'path', offset: 'offset', limit: 'limit' },
      default: { path: ' ' },
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

        values.content = internal.content || '' //.replaceAll('\\n', '\n')
        return values
      },
    },
    terax: {
      tool: 'write_file',
      params: { path: 'path', content: 'content' },
      default: { path: ' ', content: ' ' },
    },
  },

  // Edit Tools
  append: {
    desc: 'Insert content after anchor line. No anchor → EOF.',
    grammar: 'path={str}|(anchor={str})?|content={str}',
    keys: { path: ' ', anchor: ' ', content: ' ' },
    eg: [
      {
        path: '/path/to/file.txt',
        anchor: 'function login(user) {',
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

        params.old = params.anchor ? params.anchor : content.slice(-50)
        return params.old + '\n' + newContent
      }),
    ...RAW_EDIT(),
  },

  prepend: {
    desc: 'Insert content before anchor line. No anchor → BOF.',
    grammar: 'path={str}|(anchor={str})?|content={str}',
    keys: { path: ' ', anchor: ' ', content: ' ' },
    eg: [
      {
        path: '/path/to/file.txt',
        anchor: 'function login(user) {',
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

        params.old = params.anchor ? params.anchor : content.substring(0, 50)
        return newContent + '\n' + params.old
      }),
    ...RAW_EDIT(),
  },
  replace: {
    desc: 'old→new exact swap. old string must be unique in file.',
    grammar: 'path={str}|old={str}|new={str}',
    keys: { path: ' ', old: ' ', new: ' ' },
    eg: [
      {
        path: '/path/to/file.txt',
        old: 'const name = "old"',
        new: 'const name = "new"',
      },
    ],
    ...RAW_EDIT(),
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
  },
  grep: {
    desc: 'Search file contents. query=text|regex. ?regex=true for regex. ?pattern=file glob filter. ?max caps.',
    grammar: 'query={str|regex}|(regex={bool})?|(pattern={regex})?|(max={0-200})?',
    eg: [
      { query: 'search term', max: 10 },
      { query: 'search term', pattern: 'src/**' },
      { query: 'search*', regex: true, pattern: 'src/**' },
    ],
    keys: { path: ' ' },
    vscode: {
      tool: 'grep_search',
      params: {
        query: 'query',
        pattern: 'includePattern',
        regex: 'isRegex',
        max: 'maxResults',
      },
      default: { query: ' ', isRegex: false },
    },
    terax: {
      tool: 'grep',
      params: { pattern: 'pattern' },
      default: { pattern: ' ' },
    },
  },
  cmd: {
    desc: 'Run shell command. ?till=timeout secs (0-300).',
    grammar: 'run={str}|(till={0-300})?',
    eg: [
      {
        run: 'npm install',
        // goal: 'Install dependencies',
        // desc: 'Install all project dependencies using npm',
      },
      {
        run: 'npm test',
        // goal: 'Run tests',
        // desc: 'Run all project tests',
        till: 60,
      },
    ],
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
  },
  todo: {
    desc: 'Batch task list. +id=N,title=T,status=S,?desc. Status: wait|active|done. Use only when 3+ tools needed.',
    grammar: '({id={1-99}|title={str:10-50}|status={wait,active,done}|desc={str:0-500}})+',
    eg: [{ id: 1, title: 'Add button color', status: 'wait' }],
    repeatable: { id: true, title: true, status: true, desc: true },
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
  const lines = ['\n\n# AVAILABLE TOOLS']

  for (const [toolName, tool] of Object.entries(TOOLS)) {
    const mapping = tool[ide]
    if (!mapping) continue

    mapping.keysRegex = tool.keysRegex
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

    // Build grammar line
    const params = tool.grammar.replaceAll('|', '¦').replaceAll(',', '|')
    const grammar = toolName + '¦' + params

    if (tool.desc) {
      lines.push(`- \`${toolName}\` : ${tool.desc}`)
    }
    lines.push('  Format: ⟦' + grammar + '⟧')

    tool.eg.forEach((eg) => {
      const exampleArgs = Object.entries(eg)
        .map(([k, v]) => `${k}=${v}`)
        .join('¦')
      lines.push('   ' + toolName + '¦' + exampleArgs)
    })
    lines.push('')
  }

  // Build reverse map: IDE tool name → generic tool name
  const reverseMap = {}
  for (const [genericName, ideConfig] of Object.entries(resolved)) {
    reverseMap[ideConfig.tool] = genericName
  }

  const grammar = lines.join('\n')

  return {
    prompt: grammar,
    tools: resolved,
    reverseMap,
    ...IDES_PROMPT_OPTIMIZER[ide],
  }
}

module.exports = { TOOLS, getIDEMapper }
