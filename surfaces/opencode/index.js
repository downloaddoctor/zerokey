const { getAllTags } = require('../base')

// Configure an IDEToolSurface instance for OpenCode.
module.exports = (t) => {
  t.ideName = 'opencode'
  t.newSessionStartLength = 2
  t.realSessionPrefix = 'You are opencode'

  t.tool('read', 'read', { params: { path: 'filePath', offset: 'offset', limit: 'limit' } })
  t.tool('write', 'write', { params: { path: 'filePath', content: 'content' } })
  t.tool('replace', 'edit', {
    split: true,
    params: { path: 'filePath', old: 'oldString', new: 'newString' },
  })
  t.tool('ask', 'question', {
    params: { ques: 'question' },
    array: { key: 'options', fields: { option: 'label' } },
    default: { ques: '', options: [] },
    transform: (values) => {
      values.questions = [
        {
          header: 'question',
          question: values.ques || '',
          options: values.options.map((op) => ((op.description = '             '), op)),
        },
      ]
      delete values.ques
      delete values.options
    },
  })
  t.tool('ls', 'read', { params: { path: 'filePath' }, default: { filePath: ' ' } })
  t.tool('mkdir', 'bash', {
    params: { path: 'command' },
    default: { command: ' ', description: 'Create directory' },
    transform: (values, internal) => {
      values.command = `New-Item -ItemType Directory -Force -Path "${internal.path}"`
    },
  })
  t.tool('glob', 'glob', {
    params: { pattern: 'pattern', dir: 'path' },
    default: { pattern: ' ' },
  })
  t.tool('grep', 'grep', {
    params: { query: 'pattern', filter: 'include', dir: 'path' },
    default: { pattern: ' ' },
  })
  t.tool('cmd', 'bash', {
    split: true,
    params: { run: 'command', till: 'timeout', desc: 'description' },
    default: { command: ' ', description: ' ' },
    transform: (values, internal) => {
      if (internal.till) values.timeout = internal.till * 1000
    },
  })
  t.tool('cmd_bg', 'bash', {
    params: { run: 'command' },
    default: { description: 'Start background process' },
    transform: (values, internal) => {
      values.command = `Start-Process powershell -ArgumentList '-NoProfile','-Command',"${internal.run}" -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id`
    },
  })
  t.tool('cmd_poll', 'bash', {
    params: { termId: 'command' },
    default: { description: 'Check background process output' },
    transform: (values, internal) => {
      values.command = `Get-Process -Id ${internal.termId} -ErrorAction SilentlyContinue`
    },
  })
  t.tool('cmd_kill', 'bash', {
    params: { termId: 'command' },
    default: { description: 'Kill background process' },
    transform: (values, internal) => {
      values.command = `Stop-Process -Id ${internal.termId} -Force -ErrorAction SilentlyContinue`
    },
  })
  t.tool('fetch', 'webfetch', { params: { url: 'url' }, default: { format: 'markdown' } })

  const todoArray = {
    key: 'todos',
    fields: {
      title: 'content',
      status: { wait: 'pending', active: 'in_progress', done: 'completed' },
      desc: 'description',
    },
  }
  const todoTransform = (values) => {
    values.todos.forEach((todo) => {
      todo.priority = 'high'
    })
    return values
  }
  t.tool('todos_add', 'todowrite', {
    array: todoArray,
    default: { todos: [] },
    transform: todoTransform,
  })
  t.tool('todos_set', 'todowrite', {
    array: todoArray,
    default: { todos: [] },
    transform: todoTransform,
  })

  t.rawUser = (content) => (typeof content === 'string' ? content : content?.[0]?.text || '')

  t.system = (content = '') => {
    const tags = getAllTags(content)
    return tags.env ? tags.env.full : ''
  }

  t.user = (content, messages) => {
    const text = typeof content === 'string' ? content : content?.[0]?.text || ''
    const tags = getAllTags(text)
    if (tags.env) return tags.env.full
    if (messages.length <= t.newSessionStartLength) console.info('\n\n[SESSION] NEW STARTED!')
    return 'USER: ' + text
  }

  t.formatToolOutput = (name, result) => result
}
