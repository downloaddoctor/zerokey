#PROJECT
ZeroKey — OpenAI-compatible AI proxy for DeepSeek, Claude and ChatGPT
 no API keys required; uses real browser sessions via captured fetch() calls
 single Express server on configurable port, exposes /v1/models, /v1/chat/completions, /health

#DIRECTORY
server.js # entrypoint, Express app setup, session selection, shutdown handling
zerokey.bat # one-click launcher: auto-clone, install deps, check updates, start server
start.bat # Windows batch launcher (node server.js, dev use)
pnpm-lock.yaml # pnpm lockfile
config/ # constants, model definitions
 config/constants.js # CONFIG (PORT), MODEL_HASH (nested provider→model→meta with id/name/vision/created/context_length/max_output_length), MODELS registry (keyed by meta.id slug)
core/ # session management, chat router, provider API clients
 core/session-selector.js # interactive CLI wizard: provider→user→session selection; users.json persistence; Claude "(limit reached)" suffix on user list; auto-switch to available users; deleteAllSessions with provider-side cleanup; session mode as list pick (Tools Mode / Raw Mode); _validateFetchHeaders checks required headers per provider; _validateLiveConnection verifies credentials with provider API; _openBrowser auto-opens provider login page for new users
 core/chat-router.js # builds Express router for selected provider, logs active session (no runtime hot-swap)
 core/deepseek/ # DeepSeek API client, POW solver, SSE stream handler
  core/deepseek/api.js → DeepSeekAPI — chat session CRUD (create/delete/deleteAll), POW challenge, file upload (uploadFile + _pollFile), cookie management, HTTP keep-alive, optional _log flag, getCurrentUser for live validation
  core/deepseek/pow.js → DeepSeekPOW — WASM SHA3 proof-of-work solver
  core/deepseek/stream-handler.js → streamHandler — SSE parser for DeepSeek response format
 core/claude/ # Claude API client, SSE stream handler, instructions setter
  core/claude/api.js → ClaudeAPI — conversation completion, file upload (uploadFile — multipart POST to /api/orgId/upload → file_uuid), client-side UUID gen, org ID extraction, HAR-ordered headers, session delete, cookie management, HTTP keep-alive, optional _log flag, getAccountProfile for live validation
  core/claude/stream-handler.js → claudeStreamHandler(res, stream, session, parser, cb) — SSE parser, message_limit detection, delegates >=90% usage to cb callback
  core/claude/set-instructions.js → setClaudeInstructions — PUT account_profile with system prompt
 core/chatgpt/ # ChatGPT API client, POW solver, SSE stream handler, instructions setter
  core/chatgpt/api.js → ChatGPTAPI — conversation prepare, sentinel refresh, POW, conduit token flow, session deletion (PATCH), cookie management, UA extraction from proof token, HTTP keep-alive, optional _log flag, getMe for live validation
  core/chatgpt/pow.js → ChatGPTProofOfWork — SHA3-512 sentinel proof-of-work solver
  core/chatgpt/stream-handler.js → chatgptStreamHandler — SSE parser for ChatGPT response format
  core/chatgpt/set-instructions.js → setChatGPTInstructions — PATCH user_system_messages
routes/ # Express route builders (one per provider + models + health)
 routes/deepseek.js → buildDeepSeekRouter(headers, session)
 routes/claude.js → buildClaudeRouter(parsedFetch, session, userData)
 routes/chatgpt.js → buildChatGPTRouter(parsedFetch, session, userData)
 routes/models.js → buildModelsRouter(preSelected) — GET /v1/models (returns object: 'list', data, activeModel), GET /v1/models/:model (lookup by meta.id slug)
 routes/health.js → buildHealthRouter(preSelected) — GET /health (returns status, uptime, timestamp, provider, model, username)
 routes/info.js → GET / — API info (name, version, endpoints, models)
lib/engine/ # tool compilation, prompt formatting, IDE mappings
 lib/engine/index.js → ToolCompiler (singleton per ide+provider); async formatPrompt(messages, isNewSession, uploadFile) iterates from last assistant turn, dispatches by role via async handlers; user/tool handlers call decodeContentParts + uploadFile for inline file upload; parse/compile/emit tool calls; _mergeTodo; inferType
 lib/engine/dynamic-tools.js → syncDynamicTools — hash req.body.tools, register MCP passthrough tools
 lib/engine/instructions.js → Instructions singleton; lazy-loads instructions.md + skills-extra.md
 lib/engine/instructions.md # system prompt for LLM (BPI syntax, tool grammar, coding rules; XML-tagged sections)
 lib/engine/skills-extra.md # extra skills appended to instructions (editing instructions themselves)
 lib/engine/stream.js → Stream class; iterative state machine scans LLM output for tool markers, emits SSE chunks + tool_calls; _maxToolLen from tool registry
 lib/engine/tool-defs.js → TOOLS registry (read/write/replace/ask/ls/mkdir/glob/grep/cmd/view_image/todos_add/todos_set), getIDEMapper(ide), IDE-specific prompt optimizers (vscode/terax/opencode user/tool formatters)
 lib/engine/templates/ # IDE tool schemas
  lib/engine/templates/vscode.json # VS Code tool definitions
  lib/engine/templates/terax.json # Terax tool definitions
  lib/engine/templates/opencode.json # OpenCode tool definitions
utils/ # shared utilities
 utils/cookie-jar.js → CookieJar — parse Set-Cookie, seed from header, capture from fetch/raw headers, serialize to Cookie string, size getter
 utils/errors.js → toOpenAIError, classifyError — error categories: overloaded, session_expired, rate_limited, cloudflare_block, network, invalid_request, provider_error, internal
 utils/logger.js → overrides console.warn (yellow), console.error (red), console.debug (dim), adds console.success (green), console.info (blue), console.debug.mix (dim with inner ANSI preserved); exports text.* color functions (dim/bold/green/cyan/yellow/blue/red)
 utils/rate-limiter.js → acquireSlot — sliding-window rate limiter (5 req / 15s per label)
 utils/sse-reader.js → readSSE — generic SSE stream parser with 1MB buffer cap
 utils/stream-helpers.js → createSendFinalChunk, createOnError — shared SSE finalizers (flush tools, emit [DONE], update session.lastUsed; onError writes error JSON to SSE stream)
 utils/har-to-capture.js → harToCapture — convert HAR files to network-capture JSON format
 utils/extract-files.js → decodeContentParts(parts) — decode base64 data URIs from a single message's content array (image_url/file parts); no longer exports extractFiles/uploadExtractedFiles (file upload now driven by formatPrompt's uploadFile callback)
 utils/find-port.js → findPort(start, range=100) — scans ports via checkPort socket probe (resolves true when free) until an open one is found; isPortActive(p) — inverse of checkPort, resolves true when something is actively listening
 utils/sync-ide-config.js → async syncIdeConfig(preSelected?, port?) — syncs ZeroKey model entries into VS Code's chatLanguageModels.json; base is the existing target file's ZeroKey.models array; live-checks every existing model's port via isPortActive and drops any not currently listening; edits in place or appends the model with id ZK-{port}; non-fatal on failure
temp/ # runtime data: users.json, errors.txt (server error log), scratch files (not committed)
docs/ # static docs site
 docs/index.html
 docs/logos/
nodemon.json # nodemon config
start.bat # Windows batch launcher

#ENTRYPOINTS
zerokey.bat # one-click launcher: auto-clone, install deps, check updates, start server
server.js # node server.js (npm start) interactive wizard → select provider → select/create user → select/create session
 builds provider-specific router via ChatRouter.mount() → mounts at /v1/chat/completions
 auto-finds available port starting from CONFIG.PORT (default 8000)
 SIGINT/SIGTERM → selector.flush() → server.close()

#MODULES
Express 5.2.1 # HTTP framework (pre-release)
inquirer 8.2.7 # interactive CLI prompts for session selection
WASM (core/deepseek/wasm/) # SHA3 proof-of-work solver compiled from Rust
Node.js built-ins: fs, path, crypto, net, http

#BUILD
pnpm 10.13.1
 start: node server.js

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
 → findPort(CONFIG.PORT) # resolves actual running port
 → app.use('/', buildHealthRouter(preSelected)) # mounts /health with provider/model/username in payload
 → await syncIdeConfig(preSelected, port) # post-selection sync
 → ChatRouter.mount(selected)
   → buildDeepSeekRouter(headers, session) # DeepSeek
   → buildClaudeRouter(parsedFetch, session, userData) # Claude
   → buildChatGPTRouter(parsedFetch, session, userData) # ChatGPT
   → each returns Express router with POST / handler
 → app.use('/v1/chat/completions', chatRouter.middleware())
 → app.listen(port)
 → SIGINT/SIGTERM → selector.flush() → server.close()

POST /v1/chat/completions handler (all providers):
 → extract messages, model, tools from req.body
 → ToolCompiler(req.ide, provider) # singleton per ide+provider
 → syncDynamicTools(req.tools, session) # MCP tool registration, hash-based caching
 → compiler.formatPrompt(messages, isNewSession, uploadFile) # async; uploadFile closure built per-route for inline file uploads
 → isNewSession: prepend instructions + dynamic grammar
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
 → per-request:
   → uploadFile closure: pushes file IDs from decodeContentParts calls inside compiler.formatPrompt
   → (new session): setClaudeInstructions(claudeApi, userData, dynamicGrammar, disableTools)
     → PUT /api/account_profile with instructions.getFull() + dynamicGrammar
 → POST /organizations/{orgId}/chat_conversations/{uuid}/completion (files: file_uuid array)
   → header order: accept, accept-encoding, accept-language, anthropic-*, content-type, cookie, origin, priority, referer, sec-ch-ua*, sec-fetch-*, user-agent, x-activity-session-id
 → claudeStreamHandler → readSSE:
   → message_start → session.parentMessageId = message.uuid
   → content_block_delta text_delta → parser.scan(text)
   → message_limit → check utilization (5h + 7d windows)
     → if >= 90%: sets limitReached, calls route callback → route requests summary, emits ask BPI, sets waitUntil on user, process.exit(0)
   → error → onError

DeepSeek deep flow:
 → DeepSeekAPI.initialize(headers)
   → init WASM POW solver
   → seed CookieJar from initial headers
 → per-request:
   → uploadFile closure: pushes file IDs from decodeContentParts calls inside compiler.formatPrompt
     → uploadFile() → _getPowChallenge → solve POW → POST multipart/form-data → _pollFile (poll fetch_files until SUCCESS)
   → _getPowChallenge() → POST /api/v0/chat/create_pow_challenge
   → powSolver.solveChallenge(challenge) → WASM calculateHash → base64 encode
   → POST /api/v0/chat/completion (with ref_file_ids from uploads) → SSE stream
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
   provider (deepseek|claude|chatgpt): {
     username: {
       username: string,
       parsedFetch: { headers: object, body: object, url: string },
       sessions: array of { name, chatSessionId, parentMessageId, createdAt, lastUsed, disableTools, model, dynamicToolsHash?, _dynamicGrammarCache?, todos? },
       waitUntil?: number (epoch ms),
       waitReason?: string,
       instructionsHash?: string,
       instructionsAppliedAt?: ISO8601,
     }
   }
 }
req.body (POST /v1/chat/completions):
 messages array of { role: system|user|assistant|tool, content: string | content parts array }
 tools optional array of { type: 'function', function: { name, description, parameters } }
 image_url parts: { type: 'image_url', image_url: { url: 'data:mime;base64,...' } }
 file parts: { type: 'file', file: { file_data: 'data:mime;base64,...', filename: '...' } }
 DeepSeek/Claude: file/image content parts decoded inline via decodeContentParts during formatPrompt, uploaded via per-route uploadFile closure, passed as ref_file_ids / file_uuid array

res (POST /v1/chat/completions) — SSE stream:
 data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"...","choices":[{...}]}
 data: [DONE]

IDE detection:
 Authorization: Bearer (vscode|terax|opencode) → req.ide (default: 'vscode')

#ENV
PORT # server port, default 8000

#DEPENDENCIES
express ^5.2.1 # HTTP framework (pre-release)
inquirer ^8.2.7 # interactive CLI
node-fetch ^2.7.0 # HTTP client with keep-alive connection pooling
prettier ^3.8.3 # dev only

#PUBLIC-API
GET / # API info (name, version, endpoints, models)
GET /health # { status: 'healthy', uptime, timestamp, provider, model, username }
GET /v1/models # { object: 'list', data, activeModel }
GET /v1/models/:model # single model object or 404 with OpenAI error
POST /v1/chat/completions # OpenAI-compatible chat completions (SSE stream)
 Authorization: Bearer (vscode|terax|opencode) (default: vscode)
 Body: { messages: [{ role, content }], tools?: [...] }
 Response: SSE stream with text deltas + tool_calls + finish_reason

#CONFIG
CONFIG.PORT # default 8000, auto-increment if occupied (up to +100)
VS Code chatLanguageModels.json ZeroKey model entries: id ZK-{port}, maxInputTokens=200K, maxOutputTokens=64K, toolCalling=true, vision=true — synced dynamically by utils/sync-ide-config.js, not statically defined
Rate limit: 5 requests per 15-second window (per provider label: 'DeepSeek', 'Claude', 'ChatGPT')
Session timeout: 300s (5 min) for all provider HTTP requests
Stream buffer cap: 1MB (SSE reader)

#KNOWN-INVARIANTS
- MODELS keyed by meta.id (machine-readable slug, e.g. 'claude-sonnet-4-6'), not display name; id field = meta.id, name field = meta.name (display label) added for IDE consumption
- MODEL_HASH: nested { provider: { title, owned_by, models: { slug: { id, name, vision, created, context_length, max_output_length } } } } — id is canonical slug, name is display label
- /v1/models returns id = meta.id (slug) per OpenAI convention; activeModel = full meta object of pre-selected model
- No API keys — all auth via browser session cookies captured from DevTools fetch()
- ToolCompiler is singleton per (ideName, provider) pair — second instantiation returns cached instance
- Session state (parentMessageId, chatSessionId, lastUsed, todos) mutated in-memory; persisted to users.json only on shutdown via selector.flush()
- Claude rate-limit: when usage >= 90% across 5h/7d windows (compared as a 0-1 fraction, not a percentage), stream-handler delegates to route callback; route requests a conversation summary, emits an ask BPI with provider-switch options, sets waitUntil on userData, then process.exit(0). On exceeded (hard block), route emits ask BPI in SSE and exits. waitUntil/waitReason consulted at startup in SessionSelector.select() with auto-switch to available users; blocked users show "(limit reached)" suffix
- DeepSeek retries on SSE error events exactly once (re-acquires rate slot before retry)
- Header order matters for Cloudflare fingerprinting — Claude and ChatGPT build headers in exact HAR order per endpoint
- POW required: DeepSeek uses WASM SHA3, ChatGPT uses SHA3-512 with real config from user's proof token
- ChatGPT sentinel must be refreshed before every /f/conversation and /f/conversation/prepare call
- Claude requires org ID extraction from URL on init; conversation UUID pre-generated client-side
- Tools disabled per-session via disableTools flag; when disabled, instructions + dynamic grammar not prepended
- MCP tools synced per-request via SHA256 hash comparison; hash stored on session.dynamicToolsHash, grammar cached on session._dynamicGrammarCache
- KNOWN LIMITATION: syncDynamicTools has early return (line 67) that always returns dynamicGrammar='', skipping cache/rebuild. Entire dynamic grammar system (hash caching, _dynamicGrammarCache, grammarFromSchema, MCP tool registration) is dead code. MCP tools non-functional until this early return is removed.
- todos_add/todos_set tools merge delta items into session.todos; cleared when all done
- Claude instructions set via PUT /api/account_profile only on new session and only if hash changed
- ChatGPT instructions set via PATCH /backend-api/user_system_messages only on new session (currently commented out in route)
- write tool (vscode) deletes existing file before creating new one to avoid conflict
- tool-defs.js: VS Code user handler reads workspace_info from current message (not session's first message); CWD prepended from workspace_info.full on new sessions; $workspace and WORKSPACE block currently commented out
- tool-defs.js shortenToolOutput: replaces skip/cancel IDE messages with '[SKIPPED BY USER]' / '[CANCELLED BY USER]' before per-tool shortener runs
- lib/engine/index.js: formatPrompt is async; handlers receive (mes, messages, isNewSession, uploadFile); iterates from last assistant turn forward; system handler returns empty string; user handler returns empty string for attachments (file upload handled via uploadFile); tool handler uploads view_image content parts via uploadFile
- lib/engine/index.js: toolFormatter helper removed; tool results formatted inline as BPI(name): output
- server.js: unhandled route errors appended to temp/errors.txt (timestamp, method+url, status, message, stack, request body) best-effort, swallows its own write failures
- zerokey.bat: fetch/pull/rev-parse use literal 'origin' remote instead of %BRANCH% (previous version aliased origin→main incorrectly)
- temp/users.json written atomically via .tmp rename to prevent corruption
- Cookie jar shared per API client instance; cookies captured from all response headers, serialized into Cookie header for subsequent requests
 headers captured: Set-Cookie, x-oai-is, x-conduit-token (ChatGPT)
 session lastUsed updated on every successful response via sendFinalChunk
 rate limiter window resets if clock skew detected (windowStart > now)
- DeepSeek route: modelType resolved only on new session (session.model || 'expert'); passed as null otherwise
- view_image tool: added to TOOLS registry, BPI-LIST, instructions.md grammar, SHORTENERS (no-op), and vscode IDE mapping (params: { path: 'filePath' })

#EXTENSION-POINTS
- Add new provider: create core/provider/ with api.js + stream-handler.js, add route builder in routes/, update session-selector _stepProviderSelection, add case in chat-router mount()
- Add new IDE: add template in lib/engine/templates/, add IDE config in tool-defs.js IDES_PROMPT_OPTIMIZER + getIDEMapper
- Add new tool: add entry in lib/engine/tool-defs.js TOOLS with IDE mappings, add to instructions.md grammar section
- Add MCP tool support: passthrough handled by dynamic-tools.js syncDynamicTools
- Custom instructions: modify lib/engine/instructions.md and lib/engine/skills-extra.md; hash-based cache invalidation in provider set-instructions modules