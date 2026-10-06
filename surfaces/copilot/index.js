const fs = require('fs')

// Strip the SDK's <current_datetime>…</current_datetime> prefix and any
// <system_reminder>…</system_reminder> block, returning the remaining user text.
function extractSdkUserText(text) {
  if (typeof text !== 'string') return text
  let s = text
  s = s.replace(/<current_datetime>[\s\S]*?<\/current_datetime>\s*/g, '')
  s = s.replace(/<system_reminder>[\s\S]*?<\/system_reminder>\s*/g, '')
  return s.trim()
}

// Pull the working directory from the SDK system prompt's <environment_context>
// block ("* Current working directory: <path>"). Returns '' when absent.
function extractSdkCwd(content) {
  if (typeof content !== 'string') return ''
  const m = content.match(/Current working directory:\s*(.+)/)
  return m ? m[1].trim() : ''
}

// Configure an IDEToolSurface instance for the VS Code Copilot SDK surface.
module.exports = (t) => {
  t.ideName = 'copilot'
  t.newSessionStartLength = 2
  t.realSessionPrefix = 'Follow Microsoft content policies.'
  t.browserTools = true
  t.browserNameMap = {
    click_element: 'clickElement',
    drag_element: 'dragElement',
    hover_element: 'hoverElement',
    handle_dialog: 'handleDialog',
    navigate_page: 'navigatePage',
    open_browser_page: 'openBrowserPage',
    read_page: 'readPage',
    run_playwright_code: 'runPlaywrightCode',
    screenshot_page: 'screenshotPage',
    type_in_page: 'typeInPage',
  }

  t.tool('read', 'view', {
    params: { path: 'path' },
    default: { path: ' ' },
    transform: (values, internal) => {
      if (internal.from) values.view_range = [internal.from, internal.to ?? -1]
    },
  })

  t.tool('write', 'create', {
    params: { path: 'path', content: 'file_text' },
    transform: (values, internal) => {
      try {
        if (fs.existsSync(internal.path)) {
          console.warn('[WRITE] DELETE:', internal.path)
          fs.unlinkSync(internal.path)
        }
      } catch (caughtErr) {
        console.error('copilot surface: resolving internal.path failed:', caughtErr)
      }
    },
  })

  t.tool('replace', 'edit', {
    split: true,
    params: { path: 'path', old: 'old_str', new: 'new_str' },
  })

  t.tool('ask', 'ask_user', {
    params: { ques: 'question' },
    array: {
      key: 'choices',
      fields: { option: 'label' },
      transform: (options) => options.map((op) => op.label),
    },
    default: { question: '' },
    transform: (values) => {
      if (Array.isArray(values.choices) && values.choices.length) {
        values.choices = values.choices.map((c) => c.label ?? c)
      } else {
        delete values.choices
      }
    },
  })

  t.tool('ls', 'view', { params: { path: 'path' }, default: { path: true } })
  t.tool('glob', 'glob', {
    params: { pattern: 'pattern', dir: 'paths' },
    default: { pattern: ' ' },
  })
  t.tool('grep', 'grep', {
    params: { query: 'pattern', filter: 'glob', dir: 'paths' },
    default: { pattern: ' ' },
  })
  t.tool('cmd', 'powershell', {
    split: true,
    params: { run: 'command', goal: 'description' },
    default: { command: ' ', description: ' ', mode: 'sync' },
  })
  t.tool('cmd_bg', 'powershell', {
    params: { run: 'command' },
    default: { command: ' ', description: 'Run in background', mode: 'async' },
  })
  t.tool('cmd_poll', 'read_powershell', {
    params: { termId: 'shellId', tail: 'delay' },
    default: { shellId: ' ', delay: 0 },
    transform: (values, internal) => {
      values.shellId = String(internal.termId ?? '')
      values.delay = 0
    },
  })
  t.tool('cmd_kill', 'stop_powershell', {
    params: { termId: 'shellId' },
    default: { shellId: ' ' },
    transform: (values, internal) => {
      values.shellId = String(internal.termId ?? '')
    },
  })
  t.tool('fetch', 'web_fetch', { params: { url: 'url' }, default: { url: ' ' } })
  t.tool('view_image', 'view', { params: { path: 'path' }, default: { path: ' ' } })

  const array = {
    key: 'todos',
    fields: {
      id: 'id',
      title: 'title',
      status: { wait: 'pending', active: 'in_progress', done: 'done' },
      desc: 'description',
    },
  }
  const transform = (values) => {
    const rows = (values.todos || []).map((t) => ({
      id: t.id,
      title: (t.title || '').replace(/'/g, "''"),
      status: t.status || 'pending',
      description: (t.description || '').replace(/'/g, "''"),
    }))

    values.description = 'Sync todos'

    if (!rows.length) {
      delete values.todos
      values.query = 'SELECT 1;'
      return
    }

    values.query = rows
      .map(
        (r) =>
          `INSERT INTO todos (id, title, status, description) VALUES (${r.id}, '${r.title}', '${r.status}', '${r.description}') ` +
          `ON CONFLICT(id) DO UPDATE SET title=excluded.title, status=excluded.status, description=excluded.description;`,
      )
      .join(' ')
    delete values.todos
  }
  t.tool('todos_add', 'sql', { array, default: { todos: [] }, transform })
  t.tool('todos_set', 'sql', { array, default: { todos: [] }, transform })

  t.rawUser = (content) => {
    const text = typeof content === 'string' ? content : content?.[0]?.text || ''
    return extractSdkUserText(text)
  }

  t.system = (content) => {
    const cwd = extractSdkCwd(content)
    return cwd ? `<cwd>${cwd}</cwd>` : ''
  }

  t.user = (content, messages, isNewSession) => {
    const text = typeof content === 'string' ? content : content?.[0]?.text || ''
    return 'USER: ' + (isNewSession ? 'FIRST MESSAGE - ' : '') + extractSdkUserText(text)
  }
}
