const { getAllTags } = require('../base')

// Configure an IDEToolSurface instance for Terax.
module.exports = (t) => {
  t.ideName = 'terax'
  t.newSessionStartLength = 2
  t.realSessionPrefix = 'You are Terax, an AI agent'
  // Terax has no LLM-backed utility prompt today: compact.ts
  // (https://github.com/crynta/terax-ai/blob/main/src/modules/ai/lib/compact.ts)
  // is a client-side message-elision algorithm with no LLM call, and the
  // conversation title is derived from the first user message locally.
  // Add prefixes here when Terax ships an LLM utility (summarizer, rename, …).
  t.utilityPrefixes = []

  t.tool('read', 'read_file', { params: { path: 'path', offset: 'offset', limit: 'limit' } })
  t.tool('write', 'write_file', { params: { path: 'path', content: 'content' } })
  t.tool('replace', 'edit', {
    split: true,
    params: { path: 'path', old: 'old_string', new: 'new_string' },
  })
  // t.tool('ask', 'bash_run', {
  //   params: { run: 'command' },
  //   default: { command: 'echo "User question:"' },
  //   transform: (values, internal) => {
  //     values.command = `echo "[ASK] ${internal.ques || ''}"`
  //   },
  // })
  t.tool('ls', 'list_directory', { params: { path: 'path' }, default: { path: true } })
  t.tool('mkdir', 'create_directory', { params: { path: 'path' }, default: { path: ' ' } })
  t.tool('glob', 'glob', {
    params: { pattern: 'pattern', dir: 'root', max: 'max_results' },
    default: { pattern: ' ' },
  })
  t.tool('grep', 'grep', {
    params: { query: 'pattern', dir: 'root', filter: 'glob', max: 'max_results' },
    default: { pattern: ' ' },
  })
  t.tool('cmd', 'bash_run', {
    split: true,
    params: { run: 'command', till: 'timeout_secs', goal: 'goal', desc: 'desc' },
    default: { command: ' ' },
  })
  t.tool('cmd_bg', 'bash_background', { params: { run: 'command' }, default: { command: ' ' } })
  t.tool('cmd_poll', 'bash_logs', {
    params: { termId: 'handle' },
    default: { handle: 0 },
    transform: (values, internal) => {
      values.handle = parseInt(internal.termId, 10) || 0
    },
  })
  t.tool('cmd_kill', 'bash_kill', {
    params: { termId: 'handle' },
    default: { handle: 0 },
    transform: (values, internal) => {
      values.handle = parseInt(internal.termId, 10) || 0
    },
  })
  t.tool('fetch', 'bash_run', {
    params: { url: 'command' },
    default: { command: ' ' },
    transform: (values, internal) => {
      values.command = `Invoke-WebRequest -Uri "${internal.url}" -UseBasicParsing | Select-Object -ExpandProperty Content`
    },
  })

  const todoArray = {
    key: 'todos',
    fields: {
      id: 'id',
      title: 'title',
      status: { wait: 'pending', active: 'in_progress', done: 'completed' },
      desc: 'description',
    },
  }
  const todoTransform = (values) => {
    values.todos.forEach((todo) => {
      todo.id = todo.id + ''
    })
    return values
  }
  t.tool('todos_add', 'todo_write', {
    array: todoArray,
    default: { todos: [] },
    transform: todoTransform,
  })
  t.tool('todos_set', 'todo_write', {
    array: todoArray,
    default: { todos: [] },
    transform: todoTransform,
  })

  t.rawUser = (content) => {
    const envClose = content.indexOf('</env>\n\n')
    return envClose == -1 ? content : content.slice(envClose + 8)
  }

  t.user = (content, messages, isNewSession) => {
    const mes = []
    if (messages.length <= t.newSessionStartLength || isNewSession) {
      console.info('\n\n[SESSION] NEW STARTED!')
      const tags = getAllTags(content)
      if (tags.env) mes.push(tags.env.full)
    }

    const envClose = content.indexOf('</env>\n\n')
    const userMes = envClose == -1 ? content : content.slice(envClose + 8)
    mes.push('USER: ' + userMes)
    return mes.join('\n\n')
  }

  t.formatToolOutput = (name, result) => result
}
