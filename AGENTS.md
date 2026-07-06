#PROJECT
zerokey v1.0.0
language: javascript
runtime: node.js
package-manager: npm
description: OpenAI-compatible AI proxy for DeepSeek, Claude & ChatGPT — no API keys, real browser sessions

#DIRECTORY
config/: server configuration
 constants.js: CONFIG PORT, MODELS definitions
 models.json: VS Code custom endpoint model registry (ZK8-0..ZK8-3, ports 8000..8003)
core/: provider API clients + session management
 chat-router.js: ChatRouter → per-request provider route dispatch; autoSwitchMiddleware for Claude rate-limit; hot-swap on signal
 session-selector.js: SessionSelector → inquirer wizard; _stepProviderSelection, _stepUserSelection, _stepSessionSelection; switchToNextAvailable; flush
 # deleteAllSessions: POST delete_all via _fetch; called on "Delete all sessions"; non-fatal
 deepseek/: DeepSeek provider
  api.js: DeepSeekAPI → https.request, POW, cookie-jar
  pow.js: DeepSeekPOW WASM solver
  stream-handler.js: SSE stream parser; SET/BATCH/text delta dispatch; token usage capture; error retry (no saveSession)
 claude/: Claude provider
  api.js: ClaudeAPI → fetch, org-based, conversation UUID; _buildHeaders preserves exact HAR order
  stream-handler.js: SSE stream parser; message_limit → inline summary + onNearLimit callback; no saveSession
  set-instructions.js: setClaudeInstructions → PUT account_profile; hash-cached (no saveSession)
 chatgpt/: ChatGPT provider
  api.js: ChatGPTAPI → fetch, sentinel POW, conversation prepare; chatCompletion/_prepareConversation accept model param (default 'auto')
  pow.js: ChatGPTProofOfWork solver
  stream-handler.js: SSE stream parser for ChatGPT (no saveSession)
  set-instructions.js: setChatGPTInstructions → PATCH user_system_messages; hash-cached (no saveSession)
lib/: tool compilation engine
 engine/: ToolCompiler + Stream parser
  index.js: ToolCompiler(ide, provider) singleton per ide:provider pair; formatPrompt, buildPrompt(userPrompt,dynamicGrammar), syncDynamicTools(reqTools,session), parse, emit(_passthrough→raw args), compile, inferType
  dynamic-tools.js: syncDynamicTools→hash reqTools[],filter inbuilts via reverseMap,register passthrough entries in compiler.tools,store hash on session,cache grammar as session._dynamicGrammarCache; grammarFromSchema builds grammar from OpenAI input_schema
  stream.js: Stream 3-state FSM (outside / toolStartFound / inTool); emits text deltas + batched tool_calls on close
  tool-defs.js: TOOLS registry (read, patch, charPatch, replace, write, ls, mkdir, glob, grep, cmd, todo+, todo!); getIDEMapper(ide) → {tools, reverseMap, user, tool}; IDES_PROMPT_OPTIMIZER; TOOL_OUTPUT_LIMITS; user mes format: SYSTEM: OS / SHELL / CWD; USER: prefix on messages
  instructions.md: base system prompt — tool runtime format (SYNTAX/RULES/EXTRA); includes <tool_format> + <code_style> + CRITICAL + SYSTEM prefix
  skills-extra.md: extra prompt blocks (memory, save_workflow)
  instructions.js: Instructions singleton → getBase(), getExtra(), getFull(), getHash(), invalidate(); lazy-loaded, SHA-256 hash
  templates/: IDE config templates
   opencode.json: opencode IDE config
   terax.json: terax IDE config
   vscode.json: vscode IDE config
routes/: Express route handlers (factory functions, not mounted directly)
 deepseek.js: buildChatRouter(parsedFetch.headers, session) → POST /v1/chat/completions
 claude.js: buildClaudeRouter(parsedFetch, session, userData, onSwitch) → POST /v1/chat/completions; SUMMARY_PROMPT; inline summary on near-limit; auto-switch signal
 chatgpt.js: buildChatGPTRouter(parsedFetch, session, userData) → POST /v1/chat/completions
 health.js: GET /, GET /health
 models.js: GET /v1/models, GET /v1/models/:model
temp/: runtime session data
 users.json: persisted sessions per provider per user (atomic write via .tmp rename)
utils/: shared utilities
 cookie-jar.js: CookieJar → seedFromHeader, captureFromFetchHeaders, captureFromRawHeaders, toString
 errors.js: classifyError (9 categories), toOpenAIError → OpenAI-compatible error response
 har-to-capture.js: HAR file parser → parsedFetch format
 rate-limiter.js: acquireSlot → 5 calls/15s sliding window; per-label, promise-based queue
 sse-reader.js: readSSE → Web ReadableStream (fetch body); 1MB buffer cap; [DONE] detection
 stream-helpers.js: createSendFinalChunk (once-guard, flush+emit+[DONE]+lastUsed, no saveSession); createOnError
docs/: static documentation
 logos/: provider logos
server.js: Express entry; IDE middleware (Bearer header); request logger; SessionSelector wizard; ChatRouter mount; port check; graceful shutdown (flush on exit)
start.bat: Windows batch launcher
nodemon.json: nodemon config (watches core/, routes/, lib/, utils/, config/)
package.json: dependencies, scripts

#ENTRYPOINTS
start: node server.js → interactive wizard → Express on PORT
dev: npx nodemon server.js → auto-reload
win: start.bat → node server.js

#MODULES
server.js
 → express
 → config/constants → CONFIG, MODELS
 → routes/models, routes/health
 → core/session-selector → SessionSelector
 → core/chat-router → ChatRouter
 → utils/errors → toOpenAIError
 # IDE_WHITELIST: vscode, terax, opencode (unknown → vscode)
 # request logger: method/url/status/duration/IDE/body-size
 # error middleware: unhandled → OpenAI-compatible JSON; res.headersSent guard
 # graceful shutdown: SIGINT/SIGTERM → selector.flush() → server.close() → 5s force-kill

chat-router.js → ChatRouter
 → express.Router
 → routes/deepseek → buildChatRouter
 → routes/claude → buildClaudeRouter
 → routes/chatgpt → buildChatGPTRouter
 # selected: current {user, userData, provider, parsedFetch, session, sessionName}
 # mount(preSelected): builds initial router, stores selected
 # middleware(): returns express.Router with per-request dispatch + autoSwitchMiddleware
 # autoSwitchMiddleware: catches 429 Claude rate-limit → calls selector.switchToNextAvailable(lastSummary) → flushes old user → rebuilds router → retries
 # rebuildRouter(): rebuilds route handler closure with current selected

session-selector.js → SessionSelector
 → inquirer
 → users.json (atomic write)
 → models.json → model list
 # select(): full wizard → _stepProviderSelection → _stepUserSelection → _stepSessionSelection
 # switchToNextAvailable(pendingSummary): finds next Claude user without active waitUntil; creates fresh session with pendingSummary
 # flush(): _saveUser current in-memory state to disk
 # _loadAll(), _saveUser(): atomic read/write with .tmp rename
 # _stepSessionSelection: creates new named session (prompts model per provider) or reuses existing; shows model in list; sets waitUntil/waitReason cleared if expired
 # model selection: Claude → claude-sonnet-4-6/claude-sonnet-5; ChatGPT → auto; DeepSeek → expert/default/vision
 # _deleteAllSessions: deletes server-side DeepSeek sessions (if provider=deepseek) via POST delete_all; clears local sessions; returns to _createNewSession
 # deleteAllSessions: POST chat_session/delete_all via _fetch; non-fatal on error
 # _deleteAllSessions: deletes server-side DeepSeek sessions if provider=deepseek; then clears local; returns to _createNewSession

claude.js
 → core/claude/api → ClaudeAPI singleton
 → core/claude/stream-handler → claudeStreamHandler
 → core/claude/set-instructions → setClaudeInstructions
 → lib/engine → ToolCompiler (per-request, ide:claude keyed singleton)
 → utils/rate-limiter → acquireSlot
 → utils/errors → toOpenAIError
 # CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-6'
 # reads session.model (falls back to CLAUDE_DEFAULT_MODEL) → passes to main + summary calls
 # onNearLimit callback: inline summary via SUMMARY_PROMPT, captures text via monkey-patched parser.scan, stores in userData.lastSummary, calls onSwitch
 # rate_limit_error catch: sets userData.waitUntil, userData.waitReason

chatgpt.js
 → lib/engine/instructions → Instructions singleton
 → core/chatgpt/api → ChatGPTAPI
 → core/chatgpt/stream-handler → chatgptStreamHandler
 → core/chatgpt/set-instructions → setChatGPTInstructions
 → lib/engine → ToolCompiler
 → utils/rate-limiter → acquireSlot
 # reads session.model (default 'auto') → passes to chatgptApi.chatCompletion
 # new session: instructions.getFull() + dynamicGrammar prepended to prompt (setChatGPTInstructions disabled)

deepseek.js
 → core/deepseek/api → DeepSeekAPI
 → core/deepseek/stream-handler → streamHandler
 → lib/engine → ToolCompiler
 → utils/rate-limiter → acquireSlot
 → utils/errors → toOpenAIError
 # reads session.model (default 'expert') → passes as model_type on new session
 # retry logic: on error, calls retry() which re-acquires slot and re-invokes chatCompletion

index.js → ToolCompiler
 → lib/engine/instructions → Instructions singleton
 → lib/engine/tool-defs → getIDEMapper, TOOL_OUTPUT_LIMITS
 → lib/engine/stream → Stream
 # singleton cache: ToolCompiler.objects[ide:provider]
 # _handlers: system, assistant, user (IDES_PROMPT_OPTIMIZER), tool (truncated per TOOL_OUTPUT_LIMITS)
 # formatPrompt: dispatches last message to handler
 # buildPrompt: getFull() + userPrompt (new session only)
 # compile: parse → emit → IDE-specific tool call
 # parse: split ¦, infer types, handle repeatable groups ($array)
 # emit: map generic→IDE fields, handle array/split, run transformer+transform
 # _mergeTodo: merges delta items into session.todos by id

stream.js → Stream
 # 3-state FSM: outside → toolStartFound → inTool
 # scan(text): appends to buffer; detects ⟦ (enter toolStartFound) → ¦ (validate name) →  (complete, push toolBuffers)
 # flush(): forces  if mid-tool; calls emitToolCalls; emits dangling plain text
 # emitToolCalls: compiler.compile → buildCall → buildToolDelta → emit
 # callCounter: global monotonic ID for call_XXXX_toolname IDs

sse-reader.js → readSSE
 # getReader() + TextDecoder loop → processChunk → processLine
 # processChunk: split on \n, keep trailing partial in buffer
 # processLine: skips event:, parses data: JSON, handles [DONE] → onDone
 # 1MB buffer cap; onDone on stream end or error

stream-helpers.js
 # createSendFinalChunk: once-guard; parser.flush() → emit stop → [DONE] → res.end() → session.lastUsed (no disk flush)
 # createOnError: once-guard; classifyError → emit error chunk → res.end

rate-limiter.js
 # 5 req / 15s sliding window per label
 # expired or future windowStart → reset
 # wait queue: single setTimeout resolves promise after window remainder

errors.js
 # classifyError: 9 categories (overloaded, session_expired, rate_limited, cloudflare_block, auth_failed, network, invalid_request, provider_error, internal)
 # toOpenAIError: wraps classified into {error:{message,type,code,action,category,status}}

#RUNTIME-GRAPH
server start
 → SessionSelector.select() → provider/user/session wizard → returns {user, userData, provider, parsedFetch, session, sessionName}
 → new ChatRouter(selector)
 → chatRouter.mount(preSelected) → builds initial router, stores selected
 → mount /v1/chat/completions via chatRouter.middleware()
 → checkPort → find free port starting at CONFIG.PORT
 → app.listen(port)

POST /v1/chat/completions
 → ChatRouter.middleware() per-request dispatch:
   → parse Authorization header → extract IDE
   → validate messages[]
   → route to provider handler via closure (built with current selected)
 → ToolCompiler(req.ide, provider) → singleton
 → formatPrompt(messages, isNewSession)
 → if new session: buildPrompt (prepend instructions); setProviderInstructions (hash-cached)
 → acquireSlot(provider)
 → provider.chatCompletion(prompt, session, model, tools)
 → SSE headers
 → Stream(res, model, compiler, session) → FSM parser
 → streamHandler(res, stream, session, parser, ...)
   → readSSE → onData → parser.scan(text)
   → message_limit (Claude) → onNearLimit → inline summary → captures text → stores userData.lastSummary → calls onSwitch signal
   → message_stop / [DONE] → sendFinalChunk → flush + [DONE] + session.lastUsed (in-memory only)

Claude rate-limit auto-switch (autoSwitchMiddleware)
 → catch 429 → extract X-RateLimit-Reset header
 → if not resetWithin5min → 429 to client
 → set current user waitUntil/waitReason
 → selector.flush() → persist current user state
 → selector.switchToNextAvailable(lastSummary) → find next available user
 → if no user available → 429 to client
 → chatRouter.rebuildRouter() → rebuild route closure with new user
 → retry original request

#SCHEMA
User (temp/users.json keyed by provider.username)
 username: string
 parsedFetch: {headers, body, url}
 sessions: Session[]
 instructionsHash: string|null
 instructionsAppliedAt: ISO8601|null
 model: string|null
 waitUntil: timestamp|null  # ms epoch; set by rate-limit/usage-limit errors
 waitReason: string|null
 lastSummary: string|null  # captured inline summary for next session context

Session
 name: string
 chatSessionId: string|null
 parentMessageId: string|null
 createdAt: ISO8601
 lastUsed: ISO8601
 todos: {[id]: TodoItem}|undefined
 pendingSummary: string|null  # injected into first prompt of switched session
 model: string|null  # provider-specific: Claude=claude-sonnet-4-6|claude-sonnet-5, ChatGPT=auto, DeepSeek=expert|default|vision
 disableTools: boolean  # raw chat mode, no tool compilation

ToolDefinition (TOOLS in tool-defs.js)
 name: string  # read, patch, charPatch, replace, write, ls, mkdir, glob, grep, cmd, todo+, todo!
 desc: string
 grammar: string
 keys: object
 eg: array
 transformer: (params) => void  # merged at getIDEMapper time
 repeatable: object|null  # {id:true, ...} for todo+/todo!; {path:true, old:true, new:true} for replace
 vscode/terax/opencode: IDEMapping  # shared via EDIT()/TODO() spread

IDEMapping
 tool: string
 params: object  # generic→IDE field map
 default: object  # default {} if absent
 keys: object  # merged at getIDEMapper time (params + repeatable)
 transformer: (params) => void  # merged at getIDEMapper time
 transform: (args, internal) => void
 array: {key, fields}|null  # bundle into single call (vscode multi_replace, todos)
 split: boolean  # true → one call per array entry
 repeatable: object  # merged for repeatable tools

#ENV
engines.node: >=18.0.0
PORT: server port (default 8000)
