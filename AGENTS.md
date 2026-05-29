#PROJECT
xproxy v1.0.0
language: javascript
runtime: node.js
package-manager: npm
description: OpenAI-compatible API proxy for DeepSeek, ChatGPT & Claude

#DIRECTORY
config/: server configuration
 constants.js: CONFIG PORT, MODELS definitions, MODEL_ALIASES
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
  index.js: ToolCompiler → formatPrompt, buildPrompt, compile, emit
  stream.js: Stream → scans LLM output for ⟦tool¦params⟧, builds OpenAI tool_call deltas
  tool-defs.js: TOOLS registry, getIDEMapper → IDE-specific tool mappings
  instructions.md: full system prompt with output contract, enforcement, save workflow
  extra-tools.js: additional tool definitions
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
module: deepseek.js
 → express
 → ../core/deepseek/api → DeepSeekAPI
 → ../core/deepseek/stream-handler → streamHandler
 → ../utils/errors → toOpenAIError
 → ../lib/engine → ToolCompiler
module: chatgpt.js
 → express
 → ../core/chatgpt/api → ChatGPTAPI
 → ../core/chatgpt/stream-handler → chatgptStreamHandler
 → ../utils/errors → toOpenAIError
 → ../lib/engine → ToolCompiler
module: claude.js
 → express
 → ../core/claude/api → ClaudeAPI
 → ../core/claude/stream-handler → claudeStreamHandler
 → ../utils/errors → toOpenAIError
 → ../lib/engine → ToolCompiler
module: core/deepseek/api.js
 → https (keep-alive agent)
 → ../../utils/cookie-jar → CookieJar
 → ./pow → DeepSeekPOW
module: core/chatgpt/api.js
 → crypto
 → ./pow → ChatGPTProofOfWork
 → ../../utils/cookie-jar → CookieJar
module: core/claude/api.js
 → crypto
 → ../../utils/cookie-jar → CookieJar
module: index.js
 → fs, path
 → ./tool-defs → getIDEMapper
 → ./stream → Stream
 → ./instructions.md (read at buildPrompt)
module: tool-defs.js
 → fs
 → TOOLS: read, write, append, prepend, replace, list, mkdir, glob, grep, cmd, todo
 → getIDEMapper → resolves IDE-specific tool config
module: cookie-jar.js
 → Map-based cookie store
 → parseSetCookie, seedFromHeader, captureFromFetchHeaders, captureFromRawHeaders, toString
module: sse-reader.js
 → Readable (Node.js stream)
 → readSSE: unified SSE reader for Web ReadableStream + Node.js stream
module: errors.js
 → classifyError → categorized error with action
 → toOpenAIError → OpenAI-compatible error response
module: session-selector.js
 → fs, path, inquirer
 → SessionSelector: provider/user/session wizard

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
 → ToolCompiler(req.ide) → formatPrompt(messages)
 → if !session.parentMessageId && !saveInstructions → buildPrompt (system prompt + tool grammar)
 → provider.chatCompletion(prompt, session, ...)
   → deepseek: POW challenge → https POST → raw stream
   → chatgpt: prepareConversation → fetch POST → ReadableStream
   → claude: fetch POST → ReadableStream
 → set SSE headers
 → Stream(res, provider, compiler) → parser
 → streamHandler(res, rawStream, session, parser, saveSession)
   → readSSE: parse SSE lines → onData callbacks
   → parser.scan(text): detect ⟦tool¦params⟧ in stream
   → parser.flush(): compile buffered tools → OpenAI tool_call deltas
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
 grammar: string # param spec
 keys: object # valid param keys
 eg: array # usage examples
 vscode: IDEMapping
 terax: IDEMapping
 repeatable: object|null # for todo batch
 transformer: function|null # for edit tools (append/prepend)

IDEMapping
 tool: string # IDE-specific tool name
 params: object # generic→IDE field mapping
 default: object # default argument values
 transform: function # optional post-process

#ENV
PORT: server port (default 8000)
