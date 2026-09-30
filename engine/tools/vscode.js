const fs = require('fs')
const { getAllTags, filterAttachments } = require('./base')

// Configure an IDEToolSurface instance for classic VS Code Copilot Chat.
module.exports = (t) => {
  t.ideName = 'vscode'
  t.newSessionStartLength = 3
  t.realSessionPrefix = 'You are an expert AI programming assistant'

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
    params: { question: 'question' },
    array: { key: 'options', fields: { option: 'label', default: 'recommended' } },
    default: { question: '', options: [] },
    transform: (values) => {
      values.questions = [
        { header: 'question', question: values.question || '', options: values.options },
      ]
      delete values.question
      delete values.options
    },
  })

  t.tool('ls', 'list_dir', { params: { path: 'path' }, default: { path: true } })
  t.tool('mkdir', 'create_directory', { params: { path: 'dirPath' }, default: { dirPath: ' ' } })
  t.tool('glob', 'file_search', {
    params: { pattern: 'query', max: 'maxResults' },
    default: { query: ' ' },
  })
  t.tool('grep', 'grep_search', {
    params: {
      query: 'query',
      regex: 'isRegexp',
      max: 'maxResults',
      glob: 'includePattern',
      path: 'includePattern',
    },
    default: { query: ' ', isRegexp: true },
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
