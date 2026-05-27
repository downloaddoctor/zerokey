// --- VSCode-only tools ---
const EXTRA_TOOLS = {
  create_jupyter: {
    desc: 'Generates a new Jupyter Notebook (.ipynb) in VS Code. Use when user explicitly requests a new notebook.',
    grammer: 'query={str}',
    eg: [{ query: 'Create a data analysis notebook for sales data' }],
    vscode: {
      tool: 'create_new_jupyter_notebook',
      params: { query: 'query' },
      default: { query: ' ' },
    },
  },
  create_workspace: {
    desc: 'Get comprehensive setup steps to create complete project structures in a VS Code workspace. For full project initialization, not single files.',
    grammer: 'query={str}',
    eg: [{ query: 'Create a new React TypeScript project' }],
    vscode: {
      tool: 'create_new_workspace',
      params: { query: 'query' },
      default: { query: ' ' },
    },
  },
  edit_notebook: {
    desc: 'Edit an existing Notebook file in the workspace. Insert, delete, or edit cells.',
    grammer: 'path={str}|type={insert,delete,edit}|cell={str}|(code={str})?|(lang={str})?',
    eg: [
      {
        path: '/path/to/notebook.ipynb',
        type: 'insert',
        cell: 'cell_id',
        code: 'print(1)',
        lang: 'python',
      },
    ],
    vscode: {
      tool: 'edit_notebook_file',
      params: {
        path: 'filePath',
        type: 'editType',
        cell: 'cellId',
        code: 'newCode',
        lang: 'language',
      },
      default: { filePath: ' ', editType: 'insert', cellId: ' ' },
    },
  },
  fetch_web: {
    desc: 'Fetches main content from a web page. Use for summarizing or analyzing webpage content.',
    grammer: 'url={str}|query={str}',
    eg: [{ url: 'https:example.com', query: 'What is this page about?' }],
    vscode: {
      tool: 'fetch_webpage',
      params: { url: 'urls', query: 'query' },
      default: { urls: [], query: ' ' },
      transform: (values, internalObj) => {
        if (typeof internalObj.url === 'string') {
          values.urls = [internalObj.url]
        }
        return values
      },
    },
  },
  get_errors: {
    desc: 'Get compile or lint errors in a specific file or across all files. Use after editing to validate.',
    grammer: '(paths={str})?',
    eg: [{ paths: '/path/to/file.ts,/path/to/file2.ts,/path/to/file3.ts' }],
    vscode: {
      tool: 'get_errors',
      params: { paths: 'filePaths' },
      default: {},
      transform: (values, internalObj) => {
        if (internalObj.paths) {
          values.filePaths = internalObj.paths.split(',').map((p) => p.trim())
        }
        return values
      },
    },
  },
  notebook_summary: {
    desc: 'Returns list of Notebook cells with id, types, line ranges, language, and execution info.',
    grammer: 'path={str}',
    eg: [{ path: '/path/to/notebook.ipynb' }],
    vscode: {
      tool: 'copilot_getNotebookSummary',
      params: { path: 'filePath' },
      default: { filePath: ' ' },
    },
  },
  project_setup: {
    desc: 'Get project setup info for a VS Code workspace by project type. Call after create_workspace.',
    grammer: 'type={str}',
    eg: [{ type: 'vscode-extension' }],
    vscode: {
      tool: 'get_project_setup_info',
      params: { type: 'projectType' },
      default: { projectType: 'other' },
    },
  },
  vscode_api: {
    desc: 'Get VS Code API documentation for extension development. For building tools that extend VS Code itself.',
    grammer: 'query={str}',
    eg: [{ query: 'How to register a command in VS Code extension' }],
    vscode: {
      tool: 'get_vscode_api',
      params: { query: 'query' },
      default: { query: ' ' },
    },
  },
  github_repo: {
    desc: 'Searches a GitHub repository for relevant source code snippets. Only use when user asks for code from a specific GitHub repo.',
    grammer: 'repo={str}|query={str}',
    eg: [{ repo: 'microsoft/vscode', query: 'How does the extension host work?' }],
    vscode: {
      tool: 'github_repo',
      params: { repo: 'repo', query: 'query' },
      default: { repo: ' ', query: ' ' },
    },
  },
  github_search: {
    desc: 'Lexically searches a GitHub repository or org for files containing specific keywords. Uses keyword matching.',
    grammer: 'scope={str}|query={str}|(max={0-200})?',
    eg: [
      {
        scope: 'microsoft/vscode',
        query: 'language:typescript extension.ts',
        max: 50,
      },
    ],
    vscode: {
      tool: 'github_text_search',
      params: { scope: 'scope', query: 'query', max: 'maxResults' },
      default: { scope: ' ', query: ' ' },
    },
  },
  insert_edit: {
    desc: 'Insert new code into an existing file. Use once per file for all changes. Provide minimal hints with ...existing code... comments.',
    grammer: 'path={str}|explain={str}|code={str}',
    eg: [
      {
        path: '/path/to/file.ts',
        explain: 'Add age property and getter',
        code: 'age: number;\
 getAge() { return this.age; }',
      },
    ],
    vscode: {
      tool: 'insert_edit_into_file',
      params: { path: 'filePath', explain: 'explanation', code: 'code' },
      default: { filePath: ' ', explanation: ' ', code: ' ' },
    },
  },
  install_ext: {
    desc: 'Install an extension in VS Code. Use as part of workspace creation.',
    grammer: 'id={str}|name={str}',
    eg: [{ id: 'ms-python.python', name: 'Python extension' }],
    vscode: {
      tool: 'install_extension',
      params: { id: 'id', name: 'name' },
      default: { id: ' ', name: ' ' },
    },
  },
  memory: {
    desc: 'Manage persistent memory system with three scopes: user, session, repo. Commands: view, create, str_replace, insert, delete, rename.',
    grammer:
      'cmd={view,create,str_replace,insert,delete,rename}|path={str}|(text={str})?|(old={str})?|(new={str})?|(line={0-9999})?|(range={str})?|(oldPath={str})?|(newPath={str})?',
    eg: [
      { cmd: 'view', path: '/memories/' },
      {
        cmd: 'create',
        path: '/memories/notes.md',
        text: 'Important notes here',
      },
      {
        cmd: 'str_replace',
        path: '/memories/notes.md',
        old: 'old text',
        new: 'new text',
      },
      {
        cmd: 'insert',
        path: '/memories/notes.md',
        line: 5,
        text: 'inserted line',
      },
      { cmd: 'delete', path: '/memories/notes.md' },
      {
        cmd: 'rename',
        oldPath: '/memories/old.md',
        newPath: '/memories/new.md',
      },
    ],
    vscode: {
      tool: 'memory',
      params: {
        cmd: 'command',
        path: 'path',
        text: 'file_text',
        old: 'old_str',
        new: 'new_str',
        line: 'insert_line',
        range: 'view_range',
        oldPath: 'old_path',
        newPath: 'new_path',
      },
      default: { command: 'view' },
      transform: (values, internalObj) => {
        if (internalObj.range) {
          values.view_range = internalObj.range.split(',').map((n) => parseInt(n.trim()))
        }
        if (internalObj.line !== undefined) {
          values.insert_line = parseInt(internalObj.line)
        }
        return values
      },
    },
  },
  resolve_memory: {
    desc: 'Resolve a memory file path to its fully qualified URI.',
    grammer: 'path={str}',
    eg: [{ path: '/memories/session/plan.md' }],
    vscode: {
      tool: 'resolve_memory_file_uri',
      params: { path: 'path' },
      default: { path: ' ' },
    },
  },
  run_notebook: {
    desc: 'Run a code cell in a notebook file directly in the notebook editor.',
    grammer: 'path={str}|cell={str}|(reason={str})?|(continue={bool})?',
    eg: [
      {
        path: '/path/to/notebook.ipynb',
        cell: 'cell_id',
        reason: 'Run data loading cell',
      },
    ],
    vscode: {
      tool: 'run_notebook_cell',
      params: {
        path: 'filePath',
        cell: 'cellId',
        reason: 'reason',
        continue: 'continueOnError',
      },
      default: { filePath: ' ', cellId: ' ' },
    },
  },
  vscode_cmd: {
    desc: 'Run a command in VS Code. Use as part of workspace creation.',
    grammer: 'id={str}|name={str}|(args={str})?|(skip={bool})?',
    eg: [{ id: 'workbench.action.files.save', name: 'Save all files' }],
    vscode: {
      tool: 'run_vscode_command',
      params: {
        id: 'commandId',
        name: 'name',
        args: 'args',
        skip: 'skipCheck',
      },
      default: { commandId: ' ', name: ' ' },
      transform: (values, internalObj) => {
        if (internalObj.args) {
          values.args = internalObj.args.split(',').map((a) => a.trim())
        }
        return values
      },
    },
  },
  semantic_search: {
    desc: 'Run a natural language search for relevant code or documentation from the current workspace.',
    grammer: 'query={str}',
    eg: [{ query: 'How does authentication work in this project?' }],
    vscode: {
      tool: 'semantic_search',
      params: { query: 'query' },
      default: { query: ' ' },
    },
  },
  session_sql: {
    desc: 'Query the local session store containing history from past coding sessions. Uses SQLite SQL syntax.',
    grammer: 'desc={str}|(action={query,standup,reindex})?|(sql={str})?|(force={bool})?',
    eg: [
      { desc: 'Recent sessions overview', action: 'standup' },
      {
        desc: 'Find recent files',
        action: 'query',
        sql: 'SELECT * FROM sessions LIMIT 10',
      },
    ],
    vscode: {
      tool: 'session_store_sql',
      params: {
        desc: 'description',
        action: 'action',
        sql: 'query',
        force: 'force',
      },
      default: { description: ' ' },
    },
  },
  view_image: {
    desc: 'View the contents of an image file (png, jpg, jpeg, gif, webp). Use instead of read for images.',
    grammer: 'path={str}',
    eg: [{ path: '/path/to/image.png' }],
    vscode: {
      tool: 'view_image',
      params: { path: 'filePath' },
      default: { filePath: ' ' },
    },
  },
  ask_questions: {
    desc: 'Ask the user clarifying questions before proceeding. Each question has header, question text, and optional predefined options.',
    grammer: 'questions={str}',
    eg: [{ questions: 'Which framework would you prefer?' }],
    vscode: {
      tool: 'vscode_askQuestions',
      params: { questions: 'questions' },
      default: { questions: [] },
      transform: (values, internalObj) => {
        if (typeof internalObj.questions === 'string') {
          try {
            values.questions = JSON.parse(internalObj.questions)
          } catch {
            values.questions = [{ header: 'Question', question: internalObj.questions }]
          }
        }
        return values
      },
    },
  },
  list_usages: {
    desc: 'Find all usages (references, definitions, implementations) of a code symbol across the workspace.',
    grammer: 'symbol={str}|line={str}|(path={str})?',
    eg: [
      {
        symbol: 'myFunction',
        path: 'src/utils.ts',
        line: 'export function myFunction',
      },
    ],
    vscode: {
      tool: 'vscode_listCodeUsages',
      params: { symbol: 'symbol', path: 'filePath', line: 'lineContent' },
      default: { symbol: ' ', lineContent: ' ' },
    },
  },
  rename_symbol: {
    desc: 'Rename a code symbol across the workspace using the language server rename functionality.',
    grammer: 'symbol={str}|new={str}|line={str}|(path={str})?',
    eg: [
      {
        symbol: 'oldFunction',
        new: 'newFunction',
        path: 'src/utils.ts',
        line: 'export function oldFunction',
      },
    ],
    vscode: {
      tool: 'vscode_renameSymbol',
      params: {
        symbol: 'symbol',
        new: 'newName',
        path: 'filePath',
        line: 'lineContent',
      },
      default: { symbol: ' ', newName: ' ', lineContent: ' ' },
    },
  },
  search_extensions: {
    desc: 'Browse VS Code Extensions Marketplace by category, keywords, or extension IDs.',
    grammer:
      '(cat={AI,Azure,Chat,Data Science,Debuggers,Extension Packs,Education,Formatters,Keymaps,Language Packs,Linters,Machine Learning,Notebooks,Programming Languages,SCM Providers,Snippets,Testing,Themes,Visualization,Other})?|(keywords={str})?|(ids={str})?',
    eg: [{ cat: 'Themes', keywords: 'dark' }, { ids: 'ms-python.python,dbaeumer.vscode-eslint' }],
    vscode: {
      tool: 'vscode_searchExtensions_internal',
      params: { cat: 'category', keywords: 'keywords', ids: 'ids' },
      default: {},
      transform: (values, internalObj) => {
        if (internalObj.keywords && typeof internalObj.keywords === 'string') {
          values.keywords = internalObj.keywords.split(',').map((k) => k.trim())
        }
        if (internalObj.ids && typeof internalObj.ids === 'string') {
          values.ids = internalObj.ids.split(',').map((id) => id.trim())
        }
        return values
      },
    },
  },
  browser_click: {
    desc: 'Click on an element in a browser page.',
    grammer:
      'page={str}|elem={str}|(ref={str})?|(selector={str})?|(dbl={bool})?|(btn={left,right,middle})?',
    eg: [{ page: 'page123', elem: 'Submit button', ref: 'ref_001' }],
    vscode: {
      tool: 'click_element',
      params: {
        page: 'pageId',
        elem: 'element',
        ref: 'ref',
        selector: 'selector',
        dbl: 'dblClick',
        btn: 'button',
      },
      default: { pageId: ' ', element: ' ' },
    },
  },
  create_task: {
    desc: 'Creates and runs a build, run, or custom task by generating tasks.json. Use when user asks to build/run/launch with no tasks.json.',
    grammer:
      'folder={str}|label={str}|cmd={str}|(args={str})?|(bg={bool})?|(matcher={str})?|(group={str})?',
    eg: [
      {
        folder: '/path/to/workspace',
        label: 'Build project',
        cmd: 'npm run build',
        group: 'build',
      },
    ],
    vscode: {
      tool: 'create_and_run_task',
      params: { folder: 'workspaceFolder', label: 'task', cmd: 'task' },
      default: {
        workspaceFolder: ' ',
        task: { label: ' ', type: 'shell', command: ' ' },
      },
      transform: (values, internalObj) => {
        values.task = {
          label: internalObj.label || ' ',
          type: 'shell',
          command: internalObj.cmd || internalObj.run || ' ',
        }
        if (internalObj.args) {
          values.task.args =
            typeof internalObj.args === 'string'
              ? internalObj.args.split(',').map((a) => a.trim())
              : internalObj.args
        }
        if (internalObj.bg !== undefined) values.task.isBackground = internalObj.bg
        if (internalObj.matcher)
          values.task.problemMatcher = internalObj.matcher.split(',').map((m) => m.trim())
        if (internalObj.group) values.task.group = internalObj.group
        delete values.cmd
        delete values.label
        return values
      },
    },
  },
  browser_drag: {
    desc: 'Drag an element over another element in a browser page.',
    grammer:
      'page={str}|from={str}|to={str}|(fromRef={str})?|(fromSel={str})?|(toRef={str})?|(toSel={str})?',
    eg: [
      {
        page: 'page123',
        from: 'File item',
        to: 'Drop zone',
        fromRef: 'ref_001',
        toRef: 'ref_002',
      },
    ],
    vscode: {
      tool: 'drag_element',
      params: {
        page: 'pageId',
        from: 'fromElement',
        to: 'toElement',
        fromRef: 'fromRef',
        fromSel: 'fromSelector',
        toRef: 'toRef',
        toSel: 'toSelector',
      },
      default: { pageId: ' ', fromElement: ' ', toElement: ' ' },
    },
  },
  terminal_output: {
    desc: 'Get output from an active terminal execution by its ID (returned from run_in_terminal).',
    grammer: 'id={str}',
    eg: [{ id: 'abc12345-1234-1234-1234-123456789abc' }],
    vscode: {
      tool: 'get_terminal_output',
      params: { id: 'id' },
      default: { id: ' ' },
    },
  },
  browser_dialog: {
    desc: 'Respond to a pending modal (alert, confirm, prompt) or file chooser dialog on a browser page.',
    grammer: 'page={str}|(accept={bool})?|(text={str})?|(files={str})?',
    eg: [{ page: 'page123', accept: true, text: 'My input' }],
    vscode: {
      tool: 'handle_dialog',
      params: {
        page: 'pageId',
        accept: 'acceptModal',
        text: 'promptText',
        files: 'selectFiles',
      },
      default: { pageId: ' ' },
      transform: (values, internalObj) => {
        if (internalObj.files && typeof internalObj.files === 'string') {
          values.selectFiles = internalObj.files.split(',').map((f) => f.trim())
        }
        return values
      },
    },
  },
  browser_hover: {
    desc: 'Hover over an element in a browser page.',
    grammer: 'page={str}|elem={str}|(ref={str})?|(selector={str})?',
    eg: [{ page: 'page123', elem: 'Navigation menu', ref: 'ref_001' }],
    vscode: {
      tool: 'hover_element',
      params: {
        page: 'pageId',
        elem: 'element',
        ref: 'ref',
        selector: 'selector',
      },
      default: { pageId: ' ', element: ' ' },
    },
  },
  kill_terminal: {
    desc: 'Kill a terminal by its ID. Use to clean up terminals no longer needed.',
    grammer: 'id={str}',
    eg: [{ id: 'abc12345-1234-1234-1234-123456789abc' }],
    vscode: {
      tool: 'kill_terminal',
      params: { id: 'id' },
      default: { id: ' ' },
    },
  },
  browser_nav: {
    desc: 'Navigate a browser page by URL, history (back/forward), or reload.',
    grammer: 'page={str}|(type={url,back,forward,reload})?|(url={str})?',
    eg: [
      { page: 'page123', type: 'url', url: 'https:example.com' },
      { page: 'page123', type: 'reload' },
    ],
    vscode: {
      tool: 'navigate_page',
      params: { page: 'pageId', type: 'type', url: 'url' },
      default: { pageId: ' ' },
    },
  },
  browser_open: {
    desc: 'Open a new browser page at the given URL. Returns page ID for use with other browser tools.',
    grammer: '(url={str})?|(force={bool})?',
    eg: [{ url: 'https:example.com' }, { force: true }],
    vscode: {
      tool: 'open_browser_page',
      params: { url: 'url', force: 'forceNew' },
      default: {},
    },
  },
  browser_read: {
    desc: 'Get a snapshot of the current browser page state. Better than screenshot for understanding page content.',
    grammer: 'page={str}',
    eg: [{ page: 'page123' }],
    vscode: {
      tool: 'read_page',
      params: { page: 'pageId' },
      default: { pageId: ' ' },
    },
  },
  mermaid: {
    desc: 'Renders a Mermaid diagram from Mermaid.js markup.',
    grammer: 'markup={str}|(title={str})?',
    eg: [{ markup: 'graph TD; A-->B;', title: 'Flow diagram' }],
    vscode: {
      tool: 'renderMermaidDiagram',
      params: { markup: 'markup', title: 'title' },
      default: { markup: ' ' },
    },
  },
  browser_code: {
    desc: 'Run a Playwright code snippet to control a browser page. Only use if other browser tools are insufficient.',
    grammer: 'page={str}|(code={str})?|(deferred={str})?|(timeout={num})?',
    eg: [{ page: 'page123', code: 'await page.click(\"#submit\")' }],
    vscode: {
      tool: 'run_playwright_code',
      params: {
        page: 'pageId',
        code: 'code',
        deferred: 'deferredResultId',
        timeout: 'timeoutMs',
      },
      default: { pageId: ' ' },
    },
  },
  subagent: {
    desc: 'Launch a new agent to handle complex, multi-step tasks autonomously. Good for research, searching, and multi-step execution.',
    grammer: 'prompt={str}|desc={str}|(agent={str})?|(model={str})?',
    eg: [
      {
        prompt: 'Search for all API endpoints and summarize',
        desc: 'API endpoint search',
      },
    ],
    vscode: {
      tool: 'runSubagent',
      params: {
        prompt: 'prompt',
        desc: 'description',
        agent: 'agentName',
        model: 'model',
      },
      default: { prompt: ' ', description: ' ' },
    },
  },
  browser_screenshot: {
    desc: 'Capture a screenshot of a browser page or element. Use read_page for actions; this is for visual capture only.',
    grammer: 'page={str}|(ref={str})?|(selector={str})?|(elem={str})?|(scroll={bool})?',
    eg: [{ page: 'page123' }, { page: 'page123', elem: 'Chart diagram', ref: 'ref_001' }],
    vscode: {
      tool: 'screenshot_page',
      params: {
        page: 'pageId',
        ref: 'ref',
        selector: 'selector',
        elem: 'element',
        scroll: 'scrollIntoViewIfNeeded',
      },
      default: { pageId: ' ' },
    },
  },
  send_terminal: {
    desc: 'Send input text to an active terminal execution by its ID. Empty command sends Enter (for interactive prompts).',
    grammer: 'id={str}|(cmd={str})?|(wait={bool})?',
    eg: [{ id: 'abc12345-1234-1234-1234-123456789abc', cmd: 'yes' }],
    vscode: {
      tool: 'send_to_terminal',
      params: { id: 'id', cmd: 'command', wait: 'waitForOutput' },
      default: { id: ' ', command: ' ' },
    },
  },
  terminal_last: {
    desc: 'Get the last command run in the active terminal.',
    grammer: '',
    eg: [{}],
    vscode: {
      tool: 'terminal_last_command',
      params: {},
      default: {},
    },
  },
  terminal_select: {
    desc: 'Get the current selection in the active terminal.',
    grammer: '',
    eg: [{}],
    vscode: {
      tool: 'terminal_selection',
      params: {},
      default: {},
    },
  },
  browser_type: {
    desc: 'Type text or press keys in a browser page.',
    grammer: 'page={str}|(text={str})?|(key={str})?|(ref={str})?|(selector={str})?|(elem={str})?',
    eg: [
      {
        page: 'page123',
        text: 'Hello world',
        elem: 'Search box',
        ref: 'ref_001',
      },
      { page: 'page123', key: 'Enter' },
    ],
    vscode: {
      tool: 'type_in_page',
      params: {
        page: 'pageId',
        text: 'text',
        key: 'key',
        ref: 'ref',
        selector: 'selector',
        elem: 'element',
      },
      default: { pageId: ' ' },
    },
  },
}
