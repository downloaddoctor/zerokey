#PROJECT
zerokey v1.0.0
language: javascript
runtime: node.js
package-manager: npm
description: OpenAI-compatible AI proxy for DeepSeek, ChatGPT & Claude — no API keys, real browser sessions

#DIRECTORY
config/: server configuration
 constants.js: CONFIG PORT, MODELS definitions
 models.json: VS Code custom endpoint model registry
core/: provider API clients
 deepseek/: DeepSeek provider
  api.js: DeepSeekAPI → https.request, POW, cookie-jar
  pow.js: DeepSeekPOW WASM solver
  stream-handler.js: SSE stream parser for DeepSeek
 chatgpt/: ChatGPT provider
  api.js: ChatGPTAPI → fetch, sentinel POW, conversation prepare
  pow.js: ChatGPTProofOfWork solver
  stream-handler.js: SSE stream parser for ChatGPT
 claude/: Claude provider
  api.js: ClaudeAPI → fetch, org-based, conversation UUID
  stream-handler.js: SSE stream parser for Claude
 session-selector.js: inquirer-based provider/user/session selector + Claude instructions prompt
lib/: tool compilation engine
 engine/: ToolCompiler + Stream parser
  index.js: ToolCompiler → formatPrompt, buildPrompt, parse, emit, compile, inferType
  stream.js: Stream → scans LLM output for ⟦tool¦params⟧, builds OpenAI tool_call deltas
  tool-defs.js: TOOLS registry, getIDEMapper → IDE-specific tool mappings + prompt optimizer
  instructions.md: full system prompt with output contract, enforcement, save workflow
  templates/: IDE config templates
   opencode.json: opencode IDE config
   terax.json: terax IDE config
   vscode.json: vscode IDE config
routes/: Express route handlers
 chatgpt.js: POST /v1/chat/completions → ChatGPT
 claude.js: POST /v1/chat/completions → Claude
 deepseek.js: POST /v1/chat/completions → DeepSeek
 health.js: GET /, GET /health
 models.js: GET /v1/models, GET /v1/models/:model
temp/: runtime session data
 users.json: persisted sessions per provider per user
utils/: shared utilities
 cookie-jar.js: CookieJar → parse, seed, capture, serialize cookies
 errors.js: classifyError, toOpenAIError → OpenAI-compatible errors
 har-to-capture.js: HAR file parser
 sse-reader.js: readSSE → unified SSE reader for Web & Node.js streams
docs/: static documentation
 logos/: provider logos
server.js: Express app entry, IDE middleware, startup wizard
start.bat: Windows batch launcher
nodemon.json: nodemon config
package.json: dependencies, scripts

#ENTRYPOINTS
start: node server.js → interactive wizard → Express server on PORT
dev: npx nodemon server.js → auto-reload
win: start.bat → node server.js

#MODULES
module: server.js
 → express
 → ./config/constants → CONFIG, MODELS
 → ./routes/models
 → ./routes/health
 → ./routes/deepseek → buildChatRouter
 → ./routes/chatgpt → buildChatGPTRouter
 → ./routes/claude → buildClaudeRouter
 → ./core/session-selector → SessionSelector
module: routes/deepseek.js
 → express
 → ../core/deepseek/api → DeepSeekAPI
 → ../core/deepseek/stream-handler → streamHandler
 → ../utils/errors → toOpenAIError
 → ../utils/rate-limiter → acquireSlot
 → ../lib/engine → ToolCompiler
module: routes/chatgpt.js
 → express
 → ../core/chatgpt/api → ChatGPTAPI
 → ../core/chatgpt/stream-handler → chatgptStreamHandler
 → ../utils/errors → toOpenAIError
 → ../utils/rate-limiter → acquireSlot
 → ../lib/engine → ToolCompiler
module: routes/claude.js
 → express
 → ../core/claude/api → ClaudeAPI
 → ../core/claude/stream-handler → claudeStreamHandler
 → ../utils/errors → toOpenAIError
 → ../utils/rate-limiter → acquireSlot
 → ../lib/engine → ToolCompiler
module: routes/health.js
 → express
module: routes/models.js
 → express
 → ../config/constants → MODELS
module: core/deepseek/api.js
 → https (keep-alive agent)
 → crypto
 → ../../utils/cookie-jar → CookieJar
 → ./pow → DeepSeekPOW
module: core/deepseek/stream-handler.js
 → ../../utils/sse-reader → readSSE
 → ../../utils/errors → classifyError
module: core/chatgpt/api.js
 → crypto
 → ./pow → ChatGPTProofOfWork
 → ../../utils/cookie-jar → CookieJar
module: core/chatgpt/stream-handler.js
 → ../../utils/sse-reader → readSSE
 → ../../utils/errors → classifyError
module: core/claude/api.js
 → crypto
 → ../../utils/cookie-jar → CookieJar
module: core/claude/stream-handler.js
 → ../../utils/sse-reader → readSSE
 → ../../utils/errors → classifyError
module: core/session-selector.js
 → fs, path, inquirer
module: utils/har-to-capture.js
 → fs, path
module: lib/engine/index.js
 → fs, path
 → ./tool-defs → getIDEMapper
 → ./stream → Stream
 → ./instructions.md (read at buildPrompt)
module: lib/engine/tool-defs.js
 → fs
 → TOOLS: read, write, append, prepend, replace, list, mkdir, glob, grep, cmd, todo
 → RAW_EDIT → factory for vscode/terax edit tool mappings
 → resolveAnchors → resolves anchor string with \n expansion, finds index in content
 → applyTransform → reads file, computes new content, assigns params.new + params.old
 → getIDEMapper → resolves IDE-specific tool config, builds grammar prompt, returns { prompt, tools, reverseMap, user, tool }
 → IDES_PROMPT_OPTIMIZER: vscode, terax, opencode → { user, tool } message formatters
 → NEW_SESSION_START_LENGTH: per-IDE session detection thresholds
 → getAllTags / getAllTagsArray: XML-like tag extraction helpers
module: lib/engine/stream.js
 → Stream: state-machine SSE output parser
  → scan(text): 3-state parser (outside ⟦, toolStartFound, inTool) → emits text deltas
  → flush(): drains incomplete tool buffers → calls compiler.compile → emits OpenAI tool_call deltas
 → buildCall, buildToolDelta: OpenAI chunk helpers
module: utils/cookie-jar.js
 → Map-based cookie store
 → parseSetCookie, seedFromHeader, captureFromFetchHeaders, captureFromRawHeaders, toString
module: utils/sse-reader.js
 → Readable (Node.js stream)
 → readSSE: unified SSE reader for Web ReadableStream + Node.js stream; isDone guard in processChunk loop
module: utils/errors.js
 → classifyError → categorized error with action
 → toOpenAIError → OpenAI-compatible error response
module: utils/rate-limiter.js
 → acquireSlot → 5 calls/15s sliding window rate limiter → Promise-based slot acquisition with wait queue

#RUNTIME-GRAPH
server start
 → require config/constants → CONFIG, MODELS
 → create Express app
 → mount IDE middleware: req.ide ← Authorization Bearer header
 → mount /v1/models, / health routes
 → SessionSelector.select()
   → _stepProviderSelection: inquirer list deepseek|chatgpt|claude
   → _stepUserLogin: load temp/users.json, prompt or create new
     → _promptNewUser: username + fetch() paste → _parseFetchDirect
   → if claude → _stepClaudeInstructions: ask if instructions saved in Web UI
   → _stepSessionSelection: list, create, delete sessions
   → return { user, provider, parsedFetch, session, saveInstructions, saveSession }
 → build provider chat router
   → deepseek: initDeepSeekAPI → createChatSession
   → chatgpt: initializeFromJSON → sentinel refresh
   → claude: initializeFromJSON → extract orgId, pass saveInstructions
 → app.use('/v1/chat/completions', chatRouter)
 → checkPort → find available port
 → app.listen(port)

POST /v1/chat/completions
 → validate messages array
 → ToolCompiler(req.ide) → singleton per IDE
   → getIDEMapper(ide) → { tools, prompt, reverseMap, user, tool }
   → _handlers: system→prefix, assistant→prefix, user→IDES_PROMPT_OPTIMIZER user(), tool→IDES_PROMPT_OPTIMIZER tool() + reverseMap
 → formatPrompt(messages): extract last message → handler → formatted string
 → if !session.parentMessageId && !saveInstructions → buildPrompt(userPrompt) → instructions.md + USER: prompt
 → provider.chatCompletion(prompt, session, ...)
   → deepseek: POW challenge → https POST → raw stream
   → chatgpt: prepareConversation → fetch POST → ReadableStream
   → claude: fetch POST → ReadableStream
 → set SSE headers
 → Stream(res, model, compiler) → parser with toolIndex from compiler.tools
 → streamHandler(res, rawStream, session, parser, saveSession)
   → readSSE: parse SSE lines → onData callbacks
   → parser.scan(text): 3-state FSM
     → outside: scan for ⟦ → if found, emit prior text, enter toolStartFound
     → toolStartFound: scan for ¦ → validate tool name against toolIndex → enter inTool or emit as text
     → inTool: scan for ⟧ → complete tool, push payload to toolBuffers, exit to outside
   → parser.flush(): drain incomplete tool buffers
     → compile(payload): parse → emit → IDE-specific tool call(s)
     → buildOpenAI delta chunks with tool_calls array
   → on [DONE]/finish → saveSession, res.end()

#SCHEMA
User (stored in users.json by provider)
 provider: string # deepseek|chatgpt|claude
  username: string
   parsedFetch: { headers: object, body: object, url: string }
   sessions: Session[]

Session
 name: string
 chatSessionId: string|null
 parentMessageId: string|null
 createdAt: ISO8601
 lastUsed: ISO8601

ToolDefinition (in tool-defs.js TOOLS)
 name: string # tool key
 desc: string
 grammar: string # param spec with | separator
 keys: object # valid param keys (merged from params + repeatable)
 eg: array # usage examples
 vscode: IDEMapping
 terax: IDEMapping
 repeatable: object|null # for todo/replace batch
 transformer: function|null # for edit tools (append/prepend) — mutates params.path→params.old+new

IDEMapping
 tool: string # IDE-specific tool name
 params: object # generic→IDE field mapping
 default: object # default argument values
 transform: function # optional post-process (args, internal)
 array: object|null # for multi-edit/todo repeating groups
  key: string # array key name in IDE args
  fields: object # generic→IDE field mapping per item
 split: boolean # true → one call per array entry (terax multi_edit)

IDES_PROMPT_OPTIMIZER entry (in tool-defs.js)
 user: (prefix, content, messages) → formatted user message string
 tool: (result) → formatted tool result string

#ENV
PORT: server port (default 8000)
