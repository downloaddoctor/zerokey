// Shared generic tool specifications.
//
// One entry per ZeroKey generic tool. These describe the *surface-independent*
// parts: what the tool does, its MHI grammar, examples, and any cross-IDE
// parameter normalization. Each IDE surface (see ./base.js and the per-IDE
// config modules) supplies its native tool name + field mapping, which is
// merged onto a copy of these specs by IDEToolSurface#tool().

const TODO_ARRAY_FIELDS = {
  id: 'id',
  title: 'title',
  status: {
    wait: 'pending',
    active: 'in_progress',
    done: 'done',
  },
  desc: 'description',
}

const specs = {
  read: {
    desc: 'Read file → content',
    grammar: 'path={str}|(from={int}|to={int})?',
    eg: [{ path: '/path/to/file.txt' }, { path: '/path/to/file.txt', from: 1, to: 10 }],
    transformer: (params) => {
      if (params.from) {
        params.offset = params.from - 1
        if (params.to) params.limit = Math.max(params.to - params.from + 1, 1)
      }
    },
    keys: { from: true, to: true },
  },

  write: {
    desc: 'Create/overwrite file. path → file. content → full body.',
    grammar: 'path={str}|content={str}',
    eg: [{ path: '/path/to/file.txt', content: 'whole file content here' }],
  },

  replace: {
    desc: 'Exact string swap. Supports multiple edits across one or more files in one call.',
    grammar: '(path={str}|old={str}|new={str})+',
    eg: [{ path: '/path/to/file.txt', old: 'const name = "old"', new: 'const name = "new"' }],
    repeatable: { path: true, old: true, new: true },
  },

  ask: {
    desc: 'Ask the user a clarifying question. The ONLY way to request clarification — never plain text.',
    grammar: 'question={str}',
    eg: [{ question: 'Which port should the server listen on?' }],
    repeatable: { option: true, default: true },
  },

  ls: {
    desc: 'List dir children. Files + subdirs. Subdirs end with /.',
    grammar: 'path={str}',
    eg: [{ path: '/path/to/directory' }],
  },

  mkdir: {
    desc: 'mkdir -p. Creates dir + missing parents.',
    grammar: 'path={str}',
    eg: [{ path: '/path/to/new/directory' }],
  },

  glob: {
    desc: 'Find files by glob pattern. ?dir scopes the search (a directory). ?max caps results (0-200). If pattern has no glob metacharacters it is used as the directory.',
    grammar: '(dir={str})?|pattern={str}|(max={0-200})?',
    eg: [{ pattern: '**/*.js' }, { dir: 'src', pattern: '*.js' }],
    keys: { pattern: ' ', dir: ' ', max: 200 },
    transformer: (params) => {
      // "pattern becomes the dir" fallback: if no dir is given and pattern has
      // no glob metacharacters (e.g. "src/utils"), treat it as the directory
      // and search everything under it.
      const hasGlobChars = /[*?[\]{}]/.test(params.pattern || '')
      if (!params.dir && params.pattern && !hasGlobChars) {
        params.dir = params.pattern
        params.pattern = '**/*'
      }
    },
  },

  grep: {
    desc: 'Search file contents. query=text|regex. ?regex=true for regex. ?glob=file glob filter. ?max caps.',
    grammar: 'query={str|regex}|(regex={bool})?|(glob={regex})?|(max={0-200})?',
    eg: [{ query: 'search*', regex: true, glob: 'src/**', max: 20 }],
    keys: { query: ' ', queryR: ' ', regex: true, glob: ' ', path: ' ', max: 200 },
    transformer: (params) => {
      if (params.path) params.glob = params.path
      if (params.query) params.regex = false
      if (params.queryR) {
        params.query = params.queryR
        params.regex = true
        delete params.queryR
      }
      delete params.path
    },
  },

  cmd: {
    desc: 'Run shell command. ?till=timeout secs (0-300).',
    grammar: 'run={str}|(till={0-300})?',
    eg: [{ run: 'npm install' }, { run: 'npm test', till: 60 }],
    repeatable: { run: true, till: true },
  },

  cmd_bg: {
    desc: 'Start a shell command detached in the background. Returns a termId immediately, no output wait.',
    grammar: 'run={str}',
    eg: [{ run: 'npm run dev' }],
  },

  cmd_poll: {
    desc: 'Fetch output/status of a cmd_bg (or timed-out cmd) terminal by id',
    grammar: 'termId={str}|(tail={int})?',
    eg: [{ termId: 'abc-123' }, { termId: 'abc-123', tail: 100 }],
    keys: { termId: ' ', tail: 80 },
  },

  cmd_kill: {
    desc: 'Terminate a cmd_bg (or async) terminal by id. Idempotent.',
    grammar: 'termId={str}',
    eg: [{ termId: 'abc-123' }],
  },

  errors: {
    desc: 'Get compile/lint errors. all=true gets errors for all files (path ignored). vscode only — no cross-IDE fallback (lint setup varies per project).',
    grammar: 'all={bool}|(path={str})?',
    eg: [{ all: true }, { all: false, path: '/path/to/file.ts' }],
    keys: { all: ' ', path: ' ' },
  },

  fetch: {
    desc: 'Fetch main content from a URL. ?query focuses extraction on relevant content (vscode only).',
    grammar: 'url={str}|(query={str})?',
    eg: [{ url: 'https://example.com' }, { url: 'https://example.com', query: 'pricing details' }],
    keys: { url: ' ', query: ' ' },
  },

  view_image: {
    desc: 'View image file in IDE. Use for png, jpg, jpeg, gif, webp.',
    grammar: 'path={str}',
    eg: [{ path: '/absolute/path/to/image.png' }],
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
    arrayFields: TODO_ARRAY_FIELDS,
  },

  todos_set: {
    desc: 'Update status of existing tasks. id + status only. Server merges with retained list.',
    grammar: '({id={1-99}|status={active|done}})+',
    eg: [
      { id: 1, status: 'done' },
      { id: 2, status: 'active' },
    ],
    repeatable: { id: true, title: true, status: true, desc: true },
    arrayFields: TODO_ARRAY_FIELDS,
  },
}

module.exports = { specs, TODO_ARRAY_FIELDS }
