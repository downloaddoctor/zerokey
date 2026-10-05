const fs = require('fs')
const { getAllTags, filterAttachments } = require('../base')

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

// Configure an IDEToolSurface instance for classic VS Code Copilot Chat.
module.exports = (t) => {
  t.ideName = 'vscode'
  t.newSessionStartLength = 3
  t.realSessionPrefix = 'You are an expert AI programming assistant'
  t.browserTools = true
  t.formatters = DEFAULT_FORMATTERS

  t.tool('read', 'read_file', {
    params: { path: 'filePath', from: 'startLine', to: 'endLine' },
    default: { filePath: ' ', startLine: 1, endLine: 9007199254740991 },
  })

  t.tool('write', 'create_file', {
    params: { path: 'filePath', content: 'content' },
    transform: (values, internal) => {
      try {
        if (fs.existsSync(internal.path)) {
          console.warn('[WRITE] DELETE:', internal.path)
          fs.unlinkSync(internal.path)
        }
      } catch {}
    },
  })

  t.tool('replace', 'multi_replace_string_in_file', {
    array: {
      key: 'replacements',
      fields: { path: 'filePath', old: 'oldString', new: 'newString' },
    },
    default: { replacements: [], explanation: 'Multiple string replacement in the file' },
  })

  t.tool('ask', 'vscode_askQuestions', {
    params: { ques: 'question' },
    array: { key: 'options', fields: { option: 'label', default: 'recommended' } },
    default: { ques: '', options: [] },
    transform: (values) => {
      values.questions = [
        { header: 'question', question: values.ques || '', options: values.options },
      ]
      delete values.ques
      delete values.options
    },
  })

  t.tool('ls', 'list_dir', { params: { path: 'path' }, default: { path: true } })
  t.tool('mkdir', 'create_directory', { params: { path: 'dirPath' }, default: { dirPath: ' ' } })
  t.tool('glob', 'file_search', {
    params: { pattern: 'query', max: 'maxResults' },
    default: { query: ' ' },
    transform: (values, internal) => {
      // VS Code's file_search has no directory argument — it scopes by making
      // the query itself absolute. Fold dir + pattern into one query.
      if (internal.dir) {
        values.query = `${internal.dir}/${internal.pattern || '**/*'}`
      }
    },
  })
  t.tool('grep', 'grep_search', {
    params: {
      query: 'query',
      regex: 'isRegexp',
      max: 'maxResults',
      filter: 'includePattern',
      dir: 'includePattern',
    },
    default: { query: ' ', isRegexp: true },
    transform: (values, internal) => {
      // VS Code folds both the directory scope and the file filter into a
      // single includePattern. Compose them: '<dir>/<filter>' or just one.
      const dir = internal.dir ? internal.dir.replace(/\/$/, '') : ''
      const filter = internal.filter || ''
      if (dir && filter) values.includePattern = `${dir}/${filter}`
      else if (dir) values.includePattern = `${dir}/**`
      else if (filter) values.includePattern = filter
    },
  })
  t.tool('cmd', 'run_in_terminal', {
    split: true,
    params: { run: 'command', till: 'timeout', goal: 'goal', desc: 'explanation' },
    default: { command: ' ', mode: 'sync', isBackground: false, goal: ' ', explanation: ' ' },
    transform: (values, internal) => {
      if (internal.till) values.timeout = internal.till * 1000
    },
  })
  t.tool('cmd_bg', 'run_in_terminal', {
    params: { run: 'command' },
    default: {
      command: ' ',
      timeout: 1000,
      mode: 'async',
      isBackground: true,
      goal: 'Run in background',
      explanation: 'Run in background',
    },
  })
  t.tool('cmd_poll', 'get_terminal_output', { params: { termId: 'id' }, default: { id: ' ' } })
  t.tool('cmd_kill', 'kill_terminal', { params: { termId: 'id' }, default: { id: ' ' } })
  t.tool('errors', 'get_errors', {
    default: { filePaths: [] },
    transform: (values, internal) => {
      if (!internal.all && internal.path) values.filePaths = [internal.path]
    },
  })
  t.tool('fetch', 'fetch_webpage', {
    params: { url: 'urls', query: 'query' },
    default: { urls: [], query: ' ' },
    transform: (values, internal) => {
      values.urls = [internal.url]
    },
  })
  t.tool('view_image', 'view_image', { params: { path: 'filePath' } })

  const todoArray = {
    key: 'todoList',
    fields: {
      id: 'id',
      title: 'title',
      status: { wait: 'not-started', active: 'in-progress', done: 'completed' },
      desc: 'description',
    },
  }
  t.tool('todos_add', 'manage_todo_list', { array: todoArray, default: { todoList: [] } })
  t.tool('todos_set', 'manage_todo_list', { array: todoArray, default: { todoList: [] } })

  t.rawUser = (content) => {
    const tags = getAllTags(content?.[0]?.text || content)
    return tags._len ? tags.userRequest?.content || '' : content
  }

  t.user = (content, messages, isNewSession) => {
    const tags = getAllTags(content?.[0]?.text || content)
    const userText = tags._len ? tags.userRequest?.content || '' : content
    const mes = []

    if (tags.workspace_info) {
      console.info('\n\n[SESSION] NEW STARTED!')
      const [, , cwd] = tags.workspace_info.full.split('\n')
      mes.push(`<cwd>${cwd.split(' ')[1]}</cwd>`)
      return mes.filter((e) => e).join('\n\n')
    }

    if (tags.attachments?.content?.length) {
      mes.push(filterAttachments(tags.attachments.content))
    }

    mes.push('USER: ' + (isNewSession ? 'FIRST MESSAGE - ' : '') + userText)
    return mes.filter((e) => e).join('\n\n')
  }

  t.formatToolOutput = function (name, result) {
    try {
      const parsed = JSON.parse(result)
      if (Array.isArray(parsed)) {
        return (
          parsed
            .filter((item) => !item.mimeType)
            .map((item) => item.value || item.data || '')
            .filter((item) => item)
            .map((item) => this.shortenToolOutput(name, item))
            .join('') || this.shortenToolOutput(name, result)
        )
      }
    } catch {}
    return this.shortenToolOutput(name, result)
  }
}
