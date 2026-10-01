# PROJECT
ZeroKey — OpenAI-compatible AI proxy. Drives real browser/session-based chat accounts (DeepSeek, Claude, ChatGPT, Qwen — no API keys) and exposes them as an OpenAI `/v1/chat/completions` endpoint for IDE agents (VS Code, Terax, OpenCode). VS Code has two surfaces: classic Copilot Chat (`vscode`) and Copilot SDK/agent (`copilot`), distinguished at request time by system-prompt fingerprint. Node.js, CommonJS, single-process, Express 5.

# ENTRY-POINTS
server.js — boots Express, runs interactive SessionSelector wizard (temp/users.json), finds free port, syncs IDE config, mounts routers, global error handler, graceful shutdown (SIGINT/TERM/HUP, uncaughtException/unhandledRejection → temp error log).
zerokey.bat / zerokey.sh — OS launch scripts (pnpm start wrappers, not read in full).

# DIRECTORY
config/ — static app config
core/ — request routing + interactive session selection (CLI wizard)
engine/ — the MHI-tool compiler/pipeline: parses model output, converts to IDE-native tool calls, streams SSE, skill/trigger system, prompt instructions
engine/extra/ — markdown fragments injected as system/skill prompts ($tools, $agent, $R, $S, $test, etc.)
engine/mcp/ — MCP (Model Context Protocol) passthrough/auto-registration support
engine/templates/ — per-IDE config templates (opencode.json, terax.json, vscode.json) synced into the IDE's own settings
providers/ — one folder per upstream chat provider (claude, chatgpt, deepseek, qwen), each self-registering via providers/registry.js
providers/base/ — shared BaseAPI (HTTP, cookies, fetch wrapper)
surfaces/ — one flat file per IDE tool surface (vscode, copilot, terax, opencode) + registry.js (auto-discovers surfaces/*.js, keyed by each surface's ideName), base.js (IDEToolSurface), specs.js (shared generic tool specs). Unlike providers/, a surface is a single file (no folder).
routes/ — small stateless Express routers (docs, health, info, models)
utils/ — cross-cutting helpers (cookies, SSE parsing, rate limiting, logging, file capture, port-finding)
docs/ — static GitHub Pages site (unrelated to runtime)
temp/ — runtime state: users.json (accounts+sessions), profiles/<provider>/<username>/ (browser profile dirs), captures/, logs — gitignored working dir
scripts/check-modules.js — pre-commit consistency check (not read in full)

# MODULES
config/constants.js — CONFIG.PORT (env PORT, default 7250)
core/chat-router.js — buildRouter(selected): looks up provider in registry, delegates to provider.buildRouter
core/session-selector.js — SessionSelector class: interactive `prompts`-based CLI wizard for provider→user→session selection; persists to temp/users.json; handles waitPolicy (rate-limit/suspension) backoff across users; new-user flow opens Notepad/$EDITOR for pasting a browser fetch() call, parses+validates it, live-checks credentials
engine/syntax.js — MHI token constants (OPEN=⟦ CLOSE=⟧ SEP=¦ ESC=\\, NAME='MHI'); findClose/splitPayload — escape-aware raw-string scanning, mirrors the MHI syntax used by this very chat protocol
`surfaces/base.js` — IDEToolSurface base class: config fields (ideName/newSessionStartLength/realSessionPrefix), t.tool(generic, native, opts) registrar, t.format(generic, fn) + DEFAULT_FORMATTERS output shorteners, isRealSession(content), default rawUser/system/user/formatToolOutput handlers, resolve() → {tools, reverseMap, rawUser, system, user, tool}. `surfaces/specs.js` — shared per-tool specs. `surfaces/registry.js` — auto-discovers surfaces/*.js (keyed by ideName); exposes getIDEMapper(ide) + resolveSurface(messages). Per-surface files configure an instance: vscode.js, copilot.js (view/create/edit/glob/grep/powershell/…/sql; strips <current_datetime>/<system_reminder>, extracts <cwd>; errors/mkdir absent), terax.js, opencode.js.
`compiler.js` — ToolCompiler (cached per ideName+provider): uploadAndFormatPrompt (turns OpenAI messages[] into a single flat prompt string, runs skill-trigger detection via ToolCompiler.matchSkill), buildPrompt (prepends full instructions.md on new tool-calling sessions), uploadAndGetMessages (keeps the leading system message even past the last-assistant cutoff so SDK <cwd>/env context survives), parse/emit (compact "tool¦k=v" string ⇄ internal JSON ⇄ IDE-native tool-call JSON), inferType (bool/number/JSON coercion)
`pipeline.js` — StreamPipeline: per-request SSE emitter; scan() is a streaming state machine that detects ⟦tool¦...⟧ blocks character-by-character in model output and buffers them until closed, then emits them as OpenAI tool_calls deltas (emitToolCalls, grouping repeated todos_add/todos_set into one call); rawMode (ephemeral calls or non-tool-calling sessions) bypasses all of this and streams text through unmodified; setup() orchestrates registerAutoMcpServers → restoreMcpInjections → uploadAndFormatPrompt → skill short-circuit → buildPrompt
`instructions.js` — Instructions singleton: lazy sha256-cached loader for engine/extra/*.md; getFull()=instructions.md; getUnlimited()=instructions.md with <memory> replaced by agent.md's content (used by no-prompt-limit providers)
`triggers.js` — skill/trigger table: static triggers ($req captures raw HTTP request, $browser/$playwright inject MCP tool grammar via passthrough, $mcp lists tags, $mcp-dump, $test seeds temp/ scratch files) + auto-generated ones (one per engine/extra/*.md, tag = $<filename> unless overridden in EXTRA_OVERRIDES); matchMcpTrigger — fallback matcher for dynamically auto-registered MCP servers (see engine/mcp/auto.js, not read); registerAutoMcpServers/restoreMcpInjections sync req.body.tools[] MCP tool defs into the compiler's tool table per-session
engine/mcp/inject.js, engine/mcp/auto.js, engine/mcp/browser.js, `playwright.js` — MCP alias-map construction/injection (not fully read; referenced via `triggers.js`)
`registry.js` — ProviderRegistry: auto-discovers providers/<name>/index.js (skips 'base'), exposes get/getAll/getNames/getModels()
`BaseAPI.js` — shared HTTP client base: cookie jar wiring, _buildHeaders, _fetch (AbortController timeout→504, optional JSON parse + cookie capture), initializeFromJSON stub
providers/<provider>/index.js — provider manifest: name, models, promptLimit, waitPolicy (optional), createAPI, validateCredentials (live-checks pasted session), validateFetch (static header/URL shape check), buildRouter
providers/<provider>/config.js — models{}, reasoning{labels,map}, promptLimit, setupSteps (browser URL + DevTools capture instructions)
providers/<provider>/api.js — provider-specific HTTP client extending BaseAPI: chatCompletion, uploadFile, deleteSession, getCurrentUser, full header reconstruction (Cloudflare-sensitive header order)
providers/<provider>/router.js — builds the /v1/chat/completions sub-router: validates messages, constructs StreamPipeline, resolves reasoning_effort→provider tier via config.reasoning.map, calls pipeline.setup(), acquireSlot() (rate limit), calls api.chatCompletion(), pipes result through stream-handler.js, maps rate-limit/quota errors onto userData.waitUntil
providers/<provider>/stream-handler.js — parses provider SSE event types → pipeline.scan()/emit() calls; detects rate-limit/quota signals mid-stream and reports back via callback
providers/claude/set-instructions.js, `set-instructions.js` — push system instructions to provider-side conversation preferences on new tool-calling sessions
`browser-transport.js` — Playwright-driven browser automation transport (alternative to direct-fetch API transport, selected via DEEPSEEK_TRANSPORT env, default 'browser'); getSharedTransport keyed by local username → profile dir
providers/deepseek/pow.js, providers/deepseek/wasm/* — proof-of-work solving for DeepSeek's direct-API transport
`docs.js` — GET `openapi.json` (serves `openapi.json`), GET /docs (Swagger UI HTML shell)
`health.js` — GET /health (uptime, active user/provider/model)
`info.js` — GET / (API metadata + model list)
`models.js` — GET /v1/models, GET /v1/models/:model (OpenAI-shaped model list from registry.getModels())
`cookie-jar.js` — CookieJar: Map-based cookie store; parse/seed/capture (fetch-Headers or raw Node headers)/serialize
`ephemeral-session.js` — ephemeralSession(session): shallow clone with chatSessionId/parentMessageId nulled, used for ephemeral/utility calls so mutations never persist
`session-classifier.js` — thin wrapper over surfaces/registry: classifySession(ide, messages) → {isReal, surface, matched} delegates to resolveSurface(messages), which asks every IDEToolSurface whether the system prompt is its own (realSessionPrefix → isRealSession). A matched surface → isReal true; no match → isReal false (ephemeral/utility call) with surface = header ide. isRealChatSession → boolean; resolveIde(ide, messages) → matched surface or ide fallback. Routers pass resolveIde(...) into StreamPipeline so the compiler picks the right surface. Add a new surface file = no change here (auto-discovered + prefix registers automatically).
`extract-files.js` — decodeContentParts: pulls base64 data-URI images/files out of OpenAI content-parts array for upload
`sse-reader.js` — readSSE(stream, {onData,onDone,onError}): generic SSE line-parser working over both WHATWG ReadableStream and Node Readable
`rate-limiter.js` — acquireSlot(label): 15 req/60s sliding window per label; setProviderCooldown(label, ms): provider-imposed 429 cooldown overriding the window
`errors.js` — toOpenAIError(error, provider, type?, code?): classifyError() maps provider-specific error shapes (session expired, suspended, device-flagged, rate limited, quota exhausted, network, etc.) to {message, action, status} → OpenAI-shaped error JSON
`find-port.js` — findPort(start, range): scans for a free TCP port; isPortActive checker
utils/logger.js — console.{warn,error,debug,success,info} colorize output (ANSI codes); console.debug.mix for pre-colored mixed strings; tickWait(label,ms) — live \r-updating countdown, used by rate-limiter and human-delay
utils/sync-ide-config.js — syncIdeConfig(preSelected, port): writes/merges a 'ZeroKey' vendor entry into VS Code's chatLanguageModels.json (~/AppData/Roaming/Code/User/), one model id 'ZK-<port>' per running instance; prunes dead ports via /health probe + isPortActive; resolves reasoning-effort labels per model into supportsReasoningEffort; non-fatal on any error (VS Code-only, silently skipped elsewhere)
utils/sequential-queue.js — sequentialQueue(): Express middleware serializing ALL requests through one instance — each waits for the prior response's finish/close before proceeding; mounted in front of chat-router
utils/human-delay.js — humanDelay(minMs=3000,maxMs=9000): randomized await + tickWait countdown, used before provider calls to mimic human timing against bot detection
utils/har-to-capture.js — harToCapture(harPath): dev/debug tool converting browser HAR exports into the network-capture JSON shape (not wired into runtime request path)
utils/capture-request.js — captureRequest(req): writes req.body to temp/captures/req_<timestamp>.json; backs the $req trigger
utils/route-helpers.js — validateMessages(messages, res): 400s via toOpenAIError if messages[] is empty/missing; used by every provider router
utils/prompts.js — SUMMARIZE_CONVERSATION constant, shared between Claude/other routers' limit-summary flow and any skill needing the same text
utils/log-saver.js — LogSaver class + serializeError (referenced by pipeline.js/stream-handler for capped error logs; not fully read — file content not covered by this scan)

# MCP INTERNALS
engine/mcp/auto.js — hashTools(tools): sha256 of tools[] for change detection; groupToolsByServer: splits req.body.tools[] by mcp_<server>_<toolname> convention (non-matching → 'native' group, prefixed native_); buildParamSyntax: JSON-schema → MHI grammar fragment; buildAutoAliasMaps: produces {'$server': aliasMap} per discovered MCP server, consumed by triggers.js/pipeline.js
engine/mcp/inject.js — injectMcpAliases(aliasMap, compilerTools): registers each aliasMap entry as a `_passthrough` tool def (with `_validKeys` parsed from its grammar line) into the live compiler.tools table; returns the grammar block text for prompt injection
engine/mcp/browser.js — BROWSER_MCP: hand-written alias map for VS Code's built-in browser tools (click_element, navigate_page, read_page, screenshot_page, type_in_page, etc.) — vscode-only, triggered via $browser/$B
engine/mcp/playwright.js — PLAYWRIGHT_MCP: hand-written alias map for the real Playwright MCP server tool surface (browser_click, browser_snapshot, browser_evaluate, browser_navigate, etc.) — triggered via $playwright

# SKILL/EXTRA FILES
engine/extra/instructions.md — base system prompt injected on new tool-calling sessions (compiler.buildPrompt); documents full MHI syntax + all 15 tools + memory/AGENTS.md workflow + save workflow; this file IS the prompt shown to the driven LLM, structurally identical to the MHI protocol governing this session
engine/extra/agent.md — fuller agent-mode variant of instructions.md (adds explicit tree-read-before-AGENTS.md rule); spliced in in place of instructions.md's <memory> stub for no-prompt-limit providers via instructions.getUnlimited(); triggered standalone via $agent/$X
engine/extra/reminder.md — short reusable reminder text ('emit MHI as literal text...'); triggered via $R
engine/extra/summary.md — SUMMARIZE_CONVERSATION-equivalent skill text; triggered via $S
engine/extra/test.md — $test skill: seeds temp/temp.txt + temp/tempR.txt scratch files, returns a scripted end-to-end exercise of all 15 tools (todos_add/set, write, read, replace, ls, glob, grep, cmd, cmd_bg, fetch, view_image, ask) for smoke-testing a new IDE/provider integration
scripts/check-modules.js — require()'s every .js file under core/, engine/, routes/, utils/ to catch load-time errors (syntax/missing-dep); run via `pnpm check`, part of precommit
test/*.test.js — node:test suite (modules load, surface discovery/native names/formatters, session-classifier surface resolution, compiler parse→emit incl. copilot view_range + browser pre-registration + todos SQL); run via `pnpm test`, part of precommit

# ARCHITECTURE
Startup: `server.js` → SessionSelector wizard picks {provider, user, session} → syncIdeConfig writes IDE-specific settings → mounts `/v1/chat/completions` behind sequentialQueue() + the resolved provider's router.
Auth model: no API keys. Each provider account = a pasted browser fetch() call (cookies + headers), stored in temp/users.json, replayed with reconstructed headers (exact order matters — Cloudflare fingerprinting).
Request flow (per provider router): validate messages → new StreamPipeline (wraps res, classifies ephemeral vs real session, resolves tool-calling/raw mode) → pipeline.setup() (MCP registration, skill-trigger matching, prompt building via ToolCompiler) → acquireSlot (rate limit) → provider api.chatCompletion() → provider stream-handler parses upstream SSE → pipeline.scan()/emit() converts to OpenAI SSE chunks, detecting ⟦tool¦...⟧ blocks and emitting them as tool_calls.
IDE abstraction: `surfaces/` (repo root) is the single source of truth mapping ZeroKey's generic MHI-style tool grammar to each IDE's native tool schema. `surfaces/base.js` exports IDEToolSurface (a base class each surface is a *configured instance* of); `surfaces/specs.js` holds shared per-tool specs (grammar/eg/keys/repeatable/transformer); each `surfaces/<name>.js` (vscode/copilot/terax/opencode) is a config function setting ideName/newSessionStartLength/realSessionPrefix and registering native mappings via t.tool(generic, native, opts); `surfaces/registry.js` auto-discovers surfaces/*.js keyed by ideName and exposes getIDEMapper(ide) → resolved surface (cached per surface). ToolCompiler is cached per (ideName, provider) pair.
Session persistence: `session` objects (chatSessionId, parentMessageId, model, toolCalling, vision, todos, mcpInjected, dynamicToolsHash, lastUsed) live in `users.json` under providers[user].sessions[]; ephemeral/utility calls get a throwaway clone (ephemeralSession) whose mutations are discarded.
Rate/quota handling: providers surface rate-limit/suspension info via userData.waitUntil + waitPolicy (declared per-provider in index.js); SessionSelector loops user selection until a non-limited account is found.

# SCHEMA
temp/users.json: `{ [provider]: { [username]: { username, parsedFetch:{headers,body,url}, sessions:[{name, chatSessionId, parentMessageId, createdAt, lastUsed, toolCalling, vision, model, todos?, mcpInjected?, dynamicToolsHash?}], waitUntil?, waitReason? } } }`

# ENV
PORT — server port (default 7250)
DEEPSEEK_TRANSPORT — 'browser' (default, Playwright automation) | 'api' (direct fetch + PoW)

# CONFIG
.prettierrc / `eslint.config.js` — single quotes, LF line endings (per project style)
`pnpm-workspace.yaml` — pnpm workspace root (single package)
.githooks/pre-commit — runs `pnpm precommit` (format + lint + check-modules + test) 