#PROJECT
zerokey v1.0.0
language: javascript
runtime: node.js
package-manager: npm
description: OpenAI-compatible AI proxy for DeepSeek, Claude & ChatGPT — no API keys, real browser sessions

#DIRECTORY
config/: server configuration
 constants.js: CONFIG PORT, MODELS definitions
 models.json: VS Code custom endpoint model registry
core/: provider API clients
 deepseek/: DeepSeek provider
  api.js: DeepSeekAPI → https.request, POW, cookie-jar
  pow.js: DeepSeekPOW WASM solver
  stream-handler.js: SSE stream parser; SET/BATCH/text delta dispatch; token usage capture; error retry
 claude/: Claude provider
  api.js: ClaudeAPI → fetch, org-based, conversation UUID; _buildHeaders preserves exact HAR order
  stream-handler.js: SSE stream parser; message_limit → fallback model switch
  set-instructions.js: setClaudeInstructions → PUT account_profile; hash-cached, fire-and-forget
 chatgpt/: ChatGPT provider
  api.js: ChatGPTAPI → fetch, sentinel POW, conversation prepare
  pow.js: ChatGPTProofOfWork solver
  stream-handler.js: SSE stream parser for ChatGPT
  set-instructions.js: setChatGPTInstructions → PATCH user_system_messages; hash-cached, fire-and-forget
 session-selector.js: inquirer-based provider/user/session selector; saves temp/users.json atomically
lib/: tool compilation engine
 engine/: ToolCompiler + Stream parser
  index.js: ToolCompiler(ide, provider) singleton per ide:provider pair; formatPrompt, buildPrompt, parse, emit, compile, inferType
  stream.js: Stream 3-state FSM (outside / toolStartFound / inTool); emits text deltas + batched tool_calls on close ⟧
  tool-defs.js: TOOLS registry; getIDEMapper(ide) → {tools, reverseMap, user, tool}; IDES_PROMPT_OPTIMIZER; TOOL_OUTPUT_LIMITS
  instructions.md: base system prompt ≤1500 chars — used as ChatGPT/Claude custom instructions
  skills-extra.md: extra prompt blocks (memory, save_workflow)
  instructions.js: Instructions singleton → getBase(), getExtra(), getFull(), getHash(), invalidate(); lazy-loaded, SHA-256 hash
  templates/: IDE config templates
   opencode.json: opencode IDE config
   terax.json: terax IDE config
   vscode.json: vscode IDE config
routes/: Express route handlers
 deepseek.js: POST /v1/chat/completions → DeepSeek
 claude.js: POST /v1/chat/completions → Claude; resolveClaudeModel() expiry-aware fallback; setClaudeInstructions on new session
 chatgpt.js: POST /v1/chat/completions → ChatGPT; setChatGPTInstructions + prepend getExtra() on new session
 health.js: GET /, GET /health
 models.js: GET /v1/models, GET /v1/models/:model
temp/: runtime session data
 users.json: persisted sessions per provider per user (atomic write via .tmp rename)
utils/: shared utilities
 cookie-jar.js: CookieJar → seedFromHeader, captureFromFetchHeaders, captureFromRawHeaders, toString
 errors.js: classifyError (9 categories), toOpenAIError → OpenAI-compatible error response
 har-to-capture.js: HAR file parser → parsedFetch format
 rate-limiter.js: acquireSlot → 9 calls/30s sliding window; per-label, promise-based queue
 sse-reader.js: readSSE → Web ReadableStream (fetch body); 1MB buffer cap; [DONE] detection
 stream-helpers.js: createSendFinalChunk (once-guard, flush+emit+[DONE]+saveSession); createOnError
docs/: static documentation
 logos/: provider logos
server.js: Express entry; IDE middleware (Bearer header); request logger; SessionSelector wizard; provider router mount; graceful shutdown
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
 → routes/models, routes/health, routes/deepseek, routes/claude, routes/chatgpt
 → core/session-selector → SessionSelector
 → utils/errors → toOpenAIError
 # IDE_WHITELIST: vscode, terax, opencode (unknown → vscode)
 # request logger: method/url/status/duration/IDE/body-size
 # error middleware: unhandled → OpenAI-compatible JSON; res.headersSent guard
 # route catch blocks: res.headersSent guard before JSON error response
 # graceful shutdown: SIGINT/SIGTERM → server.close() → 5s force-kill

routes/claude.js
 → core/claude/api → ClaudeAPI singleton
 → core/claude/stream-handler → claudeStreamHandler
 → core/claude/set-instructions → setClaudeInstructions
 → lib/engine → ToolCompiler (per-request, ide:claude keyed singleton)
 → utils/rate-limiter → acquireSlot
 → utils/errors → toOpenAIError
 # resolveClaudeModel: checks modelFallbackExpiresAt; auto-resets to default when expired

routes/chatgpt.js
 → lib/engine/instructions → Instructions singleton
 → core/chatgpt/api → ChatGPTAPI
 → core/chatgpt/stream-handler → chatgptStreamHandler
 → core/chatgpt/set-instructions → setChatGPTInstructions
 → lib/engine → ToolCompiler
 → utils/rate-limiter → acquireSlot
 # new session: setChatGPTInstructions + prepend getExtra() to prompt

lib/engine/index.js → ToolCompiler
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

lib/engine/stream.js → Stream
 # 3-state FSM: outside → toolStartFound → inTool
 # scan(text): appends to buffer; detects ⟦ (enter toolStartFound) → ¦ (validate name) → ⟧ (complete, push toolBuffers)
 # flush(): forces ⟧ if mid-tool; calls emitToolCalls; emits dangling plain text
 # emitToolCalls: compiler.compile → buildCall → buildToolDelta → emit
 # callCounter: global monotonic ID for call_XXXX_toolname IDs

utils/sse-reader.js → readSSE
 # getReader() + TextDecoder loop → processChunk → processLine
 # processChunk: split on \n, keep trailing partial in buffer
 # processLine: skips event:, parses data: JSON, handles [DONE] → onDone
 # 1MB buffer cap; onDone on stream end or error

utils/stream-helpers.js
 # createSendFinalChunk: once-guard; parser.flush() → emit stop → [DONE] → res.end() → saveSession
 # createOnError: once-guard; classifyError → emit error chunk → res.end

utils/rate-limiter.js
 # 9 req / 30s sliding window per label
 # expired or future windowStart → reset
 # wait queue: single setTimeout resolves promise after window remainder

utils/errors.js
 # classifyError: 9 categories (overloaded, session_expired, rate_limited, cloudflare_block, auth_failed, network, invalid_request, provider_error, internal)
 # toOpenAIError: wraps classified into {error:{message,type,code,action,category,status}}

#RUNTIME-GRAPH
server start
 → SessionSelector.select() → provider/user/session wizard → returns {user, userData, provider, parsedFetch, session, saveSession}
 → build provider router (deepseek|claude|chatgpt)
 → mount /v1/chat/completions
 → checkPort → find free port starting at CONFIG.PORT
 → app.listen(port)

POST /v1/chat/completions
 → validate messages[]
 → ToolCompiler(req.ide, provider) → singleton
 → formatPrompt(messages, isNewSession)
 → if new session: buildPrompt (prepend instructions); setProviderInstructions (hash-cached)
 → acquireSlot(provider)
 → provider.chatCompletion(prompt, session, model, tools)
 → SSE headers
 → Stream(res, model, compiler, session) → FSM parser
 → streamHandler(res, stream, session, saveSession, parser, userData)
   → readSSE → onData → parser.scan(text)
   → message_limit (Claude) → sets waitUntil on userData; session-selector skips blocked users
   → message_stop / [DONE] → sendFinalChunk → flush + [DONE] + saveSession

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

Session
 name: string
 chatSessionId: string|null
 parentMessageId: string|null
 createdAt: ISO8601
 lastUsed: ISO8601
 todos: {[id]: TodoItem}|undefined

ToolDefinition (TOOLS in tool-defs.js)
 name: string
 desc: string
 grammar: string
 keys: object
 eg: array
 transformer: (params) => void
 repeatable: object|null
 vscode/terax/opencode: IDEMapping

IDEMapping
 tool: string
 params: object  # generic→IDE field map
 default: object
 keys: object  # merged at getIDEMapper time
 transformer: (params) => void  # merged at getIDEMapper time
 transform: (args, internal) => void
 array: {key, fields}|null
 split: boolean  # true → one call per array entry

#ENV
engines.node: >=18.0.0
PORT: server port (default 8000)
