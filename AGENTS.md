#PROJECT
ZeroKey — OpenAI-compatible AI proxy for DeepSeek, Claude & ChatGPT
 no API keys required; uses real browser sessions via captured fetch() calls
 single Express server on configurable port, exposes /v1/models, /v1/chat/completions, /health

#DIRECTORY
server.js # entrypoint, Express app setup, session selection, shutdown handling
config/ # constants, model definitions, IDE model configs
 config/constants.js # CONFIG (PORT), MODELS registry
 config/models.json # ZeroKey endpoint configs for IDEs (ZK8000–ZK8003)
core/ # session management, chat router, provider API clients
 core/session-selector.js # interactive CLI wizard: provider→user→session selection; users.json persistence; auto-switch
 core/chat-router.js # hot-swappable Express router; delegates to provider router; triggers auto-switch on rate limit
 core/deepseek/ # DeepSeek API client, POW solver, SSE stream handler
  core/deepseek/api.js → DeepSeekAPI — chat session CRUD, POW challenge, cookie management
  core/deepseek/pow.js → DeepSeekPOW — WASM SHA3 proof-of-work solver
  core/deepseek/stream-handler.js → streamHandler — SSE parser for DeepSeek response format
 core/claude/ # Claude API client, SSE stream handler, instructions setter
  core/claude/api.js → ClaudeAPI — conversation completion, org ID extraction, HAR-ordered headers
  core/claude/stream-handler.js → claudeStreamHandler — SSE parser, message_limit detection, auto-summary trigger
  core/claude/set-instructions.js → setClaudeInstructions — PUT account_profile with system prompt
 core/chatgpt/ # ChatGPT API client, POW solver, SSE stream handler, instructions setter
  core/chatgpt/api.js → ChatGPTAPI — conversation prepare, sentinel refresh, POW, conduit token flow, session deletion
  core/chatgpt/pow.js → ChatGPTProofOfWork — SHA3-512 sentinel proof-of-work solver
  core/chatgpt/stream-handler.js → chatgptStreamHandler — SSE parser for ChatGPT response format
  core/chatgpt/set-instructions.js → setChatGPTInstructions — PATCH user_system_messages
routes/ # Express route builders (one per provider + models + health)
 routes/deepseek.js → buildChatRouter(headers, session)
 routes/claude.js → buildClaudeRouter(parsedFetch, session, userData, onSwitch)
 routes/chatgpt.js → buildChatGPTRouter(parsedFetch, session, userData)
 routes/models.js → GET /v1/models, GET /v1/models/:model
 routes/health.js → GET /health, GET /
lib/engine/ # tool compilation, prompt formatting, IDE mappings
 lib/engine/index.js → ToolCompiler (singleton per ide+provider); parse/compile/emit tool calls; _mergeTodo
 lib/engine/dynamic-tools.js → syncDynamicTools — hash req.body.tools[], register MCP passthrough tools
 lib/engine/instructions.js → Instructions singleton; lazy-loads instructions.md + skills-extra.md
 lib/engine/instructions.md # system prompt for LLM (BPF syntax, tool grammar, coding rules)
 lib/engine/skills-extra.md # extra skills appended to instructions (editing instructions themselves)
 lib/engine/stream.js → Stream class; scans LLM output for ⟦tool⟧ markers, emits SSE chunks + tool_calls
 lib/engine/tool-defs.js → TOOLS registry (read/write/replace/patch/charPatch/ls/mkdir/glob/grep/cmd/todo+/todo!), getIDEMapper(ide), IDE-specific prompt optimizers (vscode/terax/opencode user/tool formatters)
 lib/engine/templates/ # IDE tool schemas
  lib/engine/templates/vscode.json # VS Code tool definitions (read_file, write_file, multi_replace_string_in_file, grep_search, file_search, list_dir, create_directory, create_file, run_in_terminal, manage_todo_list, etc.)
  lib/engine/templates/terax.json # Terax tool definitions (read_file, write_file, edit, multi_edit, grep, glob, bash_run, bash_background, bash_logs, bash_kill, bash_list, todo_write, create_directory, etc.)
  lib/engine/templates/opencode.json # OpenCode tool definitions (read, write, edit, glob, grep, bash, question, task, todowrite, skill, webfetch)
utils/ # shared utilities
 utils/cookie-jar.js → CookieJar — parse Set-Cookie, seed from header, capture from fetch/raw headers, serialize to Cookie string
 utils/errors.js → toOpenAIError, classifyError — error categories: overloaded, session_expired, rate_limited, cloudflare_block, network, invalid_request, provider_error, internal
 utils/rate-limiter.js → acquireSlot — sliding-window rate limiter (5 req / 15s per label)
 utils/sse-reader.js → readSSE — generic SSE stream parser with 1MB buffer cap
 utils/stream-helpers.js → createSendFinalChunk, createOnError — shared SSE finalizers (flush tools, emit [DONE], update session.lastUsed)
 utils/har-to-capture.js → harToCapture — convert HAR files to network-capture JSON format
temp/ # runtime data: users.json, scratch files (not committed)
docs/ # static docs site
 docs/index.html
 docs/logos/
nodemon.json # nodemon config
start.bat # Windows batch launcher

#ENTRYPOINTS
server.js # node server.js (npm start)
 interactive wizard → select provider (DeepSeek/Claude/ChatGPT) → select/create user → select/create session
 builds provider-specific router via ChatRouter.mount() → mounts at /v1/chat/completions
 auto-finds available port starting from CONFIG.PORT (default 8000)
 SIGINT/SIGTERM → selector.flush() → server.close()

#MODULES
Express 5.2.1 # HTTP framework (pre-release)
inquirer 8.2.7 # interactive CLI prompts for session selection
WASM (core/deepseek/wasm/) # SHA3 proof-of-work solver compiled from Rust
Node.js built-ins: fs, path, crypto, net, http

#RUNTIME-GRAPH
server.js
 → express() app setup
 → auth middleware: Authorization: Bearer <ide> → req.ide (default 'vscode')
 → GET /v1/models → modelsRouter
 → GET /, /health → healthRouter
 → SessionSelector.select() # interactive wizard
   → inquirer prompts (provider → user → session)
   → users.json read/write via _loadAll/_saveUser
   → _parseFetchDirect — parses pasted fetch() string into { headers, body, url }
   → Claude: check waitUntil on all users, offer switch or re-prompt
   → DeepSeekAPI.createChatSession() / reuse existing chatSessionId
   → returns { user, userData, provider, parsedFetch, session, sessionName }
 → ChatRouter.mount(selected)
   → buildChatRouter(headers, session) # DeepSeek
   → buildClaudeRouter(parsedFetch, session, userData, onSwitch) # Claude
   → buildChatGPTRouter(parsedFetch, session, userData) # ChatGPT
   → each returns Express router with POST / handler
 → app.use('/v1/chat/completions', chatRouter.middleware())
 → app.listen(port)
 → SIGINT/SIGTERM → selector.flush() → server.close()

POST /v1/chat/completions handler (all providers):
 → extract messages, model, tools from req.body
 → ToolCompiler(req.ide, provider) # singleton per ide+provider
 → syncDynamicTools(req.tools, session) # MCP tool registration, hash-based caching
 → compiler.formatPrompt(messages, isNewSession) # converts OpenAI messages to provider-specific format
 → isNewSession: prepend instructions + dynamic grammar + optionally pending summary
 → acquireSlot(provider) # rate limit
 → provider API chatCompletion() → returns ReadableStream
 → StreamHandler → readSSE → parser.scan() → Stream.flush() → emitToolCalls()

ChatGPT deep flow:
 → ChatGPTAPI.initializeFromJSON(parsedFetch)
   → seed CookieJar from initial headers
   → decode proof token → extract config + user-agent
   → _refreshSentinel()
     → generateSentinelProof(config) → POST /backend-api/sentinel/chat-requirements/prepare
     → solve POW (SHA3-512, iterate counter up to 100k)
     → store prepare_token, proof_token, turnstile_token in headers
 → per-request:
   → _refreshSentinel()
   → _prepareConversation(conversationId, parentMessageId, partialQuery, model)
     → POST /backend-api/f/conversation/prepare → capture conduit_token
   → POST /backend-api/f/conversation → SSE stream
   → capture response cookies, x-oai-is, conduit_token
 → streamHandler → readSSE → onData dispatches by type/path:
   → input_message → session.parentMessageId
   → message_stream_complete → sendFinalChunk
   → /message/content/parts/0 append → parser.scan(text)
   → patch finished_successfully → sendFinalChunk

Claude deep flow:
 → ClaudeAPI.initializeFromJSON(parsedFetch)
   → extract orgId from URL
   → seed CookieJar from initial headers
 → per-request (new session):
   → setClaudeInstructions(claudeApi, userData, dynamicGrammar, disableTools)
     → PUT /api/account_profile with instructions.getFull() + dynamicGrammar
 → POST /organizations/{orgId}/chat_conversations/{uuid}/completion
   → header order: accept, accept-encoding, accept-language, anthropic-*, content-type, cookie, origin, priority, referer, sec-ch-ua*, sec-fetch-*, user-agent, x-activity-session-id
 → claudeStreamHandler → readSSE:
   → message_start → session.parentMessageId = message.uuid
   → content_block_delta text_delta → parser.scan(text)
   → message_limit → check utilization (5h + 7d windows)
     → if ≥ 95%: after stream ends, send summary prompt, stream summary inline, call onSwitch()
   → error → onError
 → onSwitch → ChatRouter.triggerSwitch()
   → selector.flush()
   → selector.switchToNextAvailable(pendingSummary) → finds next Claude user without waitUntil
   → ChatRouter.mount(nextSelected)

DeepSeek deep flow:
 → DeepSeekAPI.initialize(headers)
   → init WASM POW solver
   → seed CookieJar from initial headers
 → per-request:
   → _getPowChallenge() → POST /api/v0/chat/create_pow_challenge
   → powSolver.solveChallenge(challenge) → WASM calculateHash → base64 encode
   → POST /api/v0/chat/completion → SSE stream
   → capture response cookies
 → streamHandler → readSSE:
   → error type → retry once (re-acquire slot, re-call chatCompletion)
   → SET FINISHED → sendFinalChunk
   → BATCH → capture token usage
   → response fragments → parser.scan(content)
   → bare string v → parser.scan(text)

#SCHEMA
users.json (temp/users.json):
 {
   [provider: 'deepseek'|'claude'|'chatgpt']: {
     [username: string]: {
       username: string,
       parsedFetch: {
         headers: { [key: string]: string },
         body: object,
         url: string
       },
       sessions: [
         {
           name: string,
           chatSessionId: string | null,
           parentMessageId: string | null,
           createdAt: ISO8601,
           lastUsed: ISO8601,
           disableTools: boolean,
           model: string,
           pendingSummary?: string,
           dynamicToolsHash?: string,
           _dynamicGrammarCache?: string,
           todos?: { [id: string]: { id, title, status, desc } }
         }
       ],
       waitUntil?: number (epoch ms),
       waitReason?: string,
       instructionsHash?: string,
       instructionsAppliedAt?: ISO8601,
       lastSummary?: string
     }
   }
 }

req.body (POST /v1/chat/completions):
 {
   messages: [{ role: 'system'|'user'|'assistant'|'tool', content: string | [{ type: 'text', text: string }] }],
   tools?: [{ type: 'function', function: { name: string, description: string, parameters: object } }]
 }

res (POST /v1/chat/completions) — SSE stream:
 data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"...","choices":[{"index":0,"delta":{"role":"assistant","content":"text"},"finish_reason":null}]}
 data: {"id":"...","object":"chat.completion.chunk","created":...,"model":"...","choices":[{"index":0,"delta":{"tool_calls":[...]},"finish_reason":null}]}
 data: {"id":"...","object":"chat.completion.chunk","created":...,"model":"...","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{...}}
 data: [DONE]

IDE detection:
 Authorization: Bearer <vscode|terax|opencode> → req.ide (default: 'vscode')

#ENV
PORT # server port, default 8000

#DEPENDENCIES
express ^5.2.1 # HTTP framework (pre-release)
inquirer ^8.2.7 # interactive CLI
prettier ^3.8.3 # dev only

#PUBLIC-API
GET / # API info (name, version, endpoints, models)
GET /health # { status: 'healthy', uptime, timestamp }
GET /v1/models # { object: 'list', data: [DeepSeek V4, GPT-4o, Claude Sonnet 4.6] }
GET /v1/models/:model # single model object or 404 with OpenAI error
POST /v1/chat/completions # OpenAI-compatible chat completions (SSE stream)
 Authorization: Bearer <vscode|terax|opencode> (default: vscode)
 Body: { messages: [{ role, content }], tools?: [...] }
 Response: SSE stream with text deltas + tool_calls + finish_reason

#CONFIG
CONFIG.PORT # default 8000, auto-increment if occupied (up to +100)
config/models.json # IDE endpoint definitions: ZK8000–ZK8003 (ports 8000–8003), all maxInputTokens=1M, maxOutputTokens=128K, toolCalling=true
Rate limit: 5 requests per 15-second window (per provider label: 'DeepSeek', 'Claude', 'ChatGPT')
Session timeout: 300s (5 min) for all provider HTTP requests
Stream buffer cap: 1MB (SSE reader)

#KNOWN-INVARIANTS
- No API keys — all auth via browser session cookies captured from DevTools fetch()
- ToolCompiler is singleton per (ideName, provider) pair — second instantiation returns cached instance
- Session state (parentMessageId, chatSessionId, lastUsed, todos) mutated in-memory; persisted to users.json only on shutdown via selector.flush() or before auto-switch
- Claude auto-switch: when usage ≥ 95% across 5h/7d windows, inline summary generated after stream, session switched to next available user via ChatRouter.triggerSwitch()
- DeepSeek retries on SSE error events exactly once (re-acquires rate slot before retry)
- Header order matters for Cloudflare fingerprinting — Claude and ChatGPT build headers in exact HAR order per endpoint
- POW required: DeepSeek uses WASM SHA3, ChatGPT uses SHA3-512 with real config from user's proof token
- ChatGPT sentinel must be refreshed before every /f/conversation and /f/conversation/prepare call
- Claude requires org ID extraction from URL on init; conversation UUID pre-generated client-side
- Tools disabled per-session via disableTools flag; when disabled, instructions + dynamic grammar not prepended
- MCP tools synced per-request via SHA256 hash comparison; hash stored on session.dynamicToolsHash, grammar cached on session._dynamicGrammarCache
- todo+/todo! tools merge delta items into session.todos; cleared when all done
- Claude instructions set via PUT /api/account_profile only on new session and only if hash changed
- ChatGPT instructions set via PATCH /backend-api/user_system_messages only on new session (currently commented out in route)
- write tool (vscode) deletes existing file before creating new one to avoid conflict
- temp/users.json written atomically via .tmp rename to prevent corruption
- Cookie jar shared per API client instance; cookies captured from all response headers, serialized into Cookie header for subsequent requests
 headers captured: Set-Cookie, x-oai-is, x-conduit-token (ChatGPT)
 session lastUsed updated on every successful response via sendFinalChunk
 rate limiter window resets if clock skew detected (windowStart > now)

#EXTENSION-POINTS
- Add new provider: create core/<provider>/ with api.js + stream-handler.js, add route builder in routes/, update session-selector _stepProviderSelection, add case in chat-router mount()
- Add new IDE: add template in lib/engine/templates/, add IDE config in tool-defs.js IDES_PROMPT_OPTIMIZER + getIDEMapper
- Add new tool: add entry in lib/engine/tool-defs.js TOOLS with IDE mappings, add to instructions.md grammar section
- Add MCP tool support: passthrough handled by dynamic-tools.js syncDynamicTools
- Custom instructions: modify lib/engine/instructions.md and lib/engine/skills-extra.md; hash-based cache invalidation in provider set-instructions modules
