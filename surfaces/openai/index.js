'use strict'

// The 'openai' surface — the default for any client that is not a known IDE.
// Declares an identity mapping for every generic tool (native name === generic
// name) and passes user/system text through unchanged, so a plain OpenAI-API
// client can drive ZeroKey's internal MHI executors without an IDE.
//
// Never matched by system-prompt prefix: `realSessionPrefix` stays null, so
// registry.resolveSurface() cannot select it. utils/session-classifier.js
// reaches it whenever no IDE fingerprint and no utility prefix match — see
// classifySession.
module.exports = (t) => {
  t.ideName = 'openai'
  t.newSessionStartLength = 0
  t.realSessionPrefix = null

  t.system = (content) => content
  t.user = (content, _messages, isNewSession) =>
    'USER: ' + (isNewSession ? 'FIRST MESSAGE - ' : '') + content

  // Identity mapping: generic tool name === native tool name === MHI grammar
  // name. Params use the same keys the MHI grammar declares, so no renaming
  // is required between parse() and emit().
  const identity = (generic, extra = {}) => t.tool(generic, generic, extra)

  identity('read', { params: { path: 'path', from: 'from', to: 'to' } })
  identity('write', { params: { path: 'path', content: 'content' } })
  identity('replace', { params: { path: 'path', old: 'old', new: 'new' } })
  identity('ls', { params: { path: 'path' } })
  identity('mkdir', { params: { path: 'path' } })
  identity('glob', { params: { pattern: 'pattern', dir: 'dir', max: 'max' } })
  identity('grep', { params: { query: 'query', dir: 'dir', filter: 'filter', max: 'max' } })
  identity('cmd', { params: { run: 'run', till: 'till' } })
  identity('cmd_bg', { params: { run: 'run' } })
  identity('cmd_poll', { params: { termId: 'termId' } })
  identity('cmd_kill', { params: { termId: 'termId' } })
  identity('errors', { params: { path: 'path' } })
  identity('fetch', { params: { url: 'url', query: 'query' } })
  identity('view_image', { params: { path: 'path' } })

  t.tool('ask', 'ask', {
    params: { ques: 'ques' },
    array: { key: 'option', fields: { option: 'option' } },
    default: { ques: '', option: [] },
  })

  // todos_add / todos_set rely on specs.js's TODO_ARRAY_FIELDS; the array
  // mapping is already declared there. We only need the identity native name.
  t.tool('todos_add', 'todos_add')
  t.tool('todos_set', 'todos_set')

  // No output formatters — this surface trusts its own tool output verbatim.
}
