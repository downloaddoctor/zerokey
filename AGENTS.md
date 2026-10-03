# ZeroKey — Agent Context

## PROJECT
ZeroKey — OpenAI-compatible local AI proxy for DeepSeek, Claude, ChatGPT, Qwen using real browser sessions (no API keys).
Node >=22, pnpm@10.13.1, CommonJS. Personal-use, non-commercial license.

## ENTRY-POINTS
scripts/start.js — authoritative starter: /health probe, PID lock (wx), post-lock probe, legacy import, then server.js
server.js — express app; exports { app, start({ db, preSelected }), stop }; listens on CONFIG.HOST:CONFIG.PORT
zerokey.bat / zerokey.sh — portable launchers (clone + toolchain + pnpm start)
package.json scripts: start (scripts/start.js), lint, format, check (scripts/check-modules.js), test (node --test), precommit

## DIRECTORY
config/ — constants.js (PORT, EXACT_PORT, DATA_DIR, DB_FILE, LOCK_FILE, LOG_DIR, LOG_LEVEL, LOG_MAX_BYTES, LOG_KEEP)
core/ — chat-router.js, session-selector.js
core/state/ — db.js (open, schema gate, migrate), schema.sql, sessions.js, import-legacy.js
core/mhi/ — internal MHI executors: parser.js (block grammar + validation), path-policy.js (workspace-bound paths, UNC/ADS/reserved-name refusal), files.js (read/ls/glob/grep/write/replace — bounded, atomic), commands.js (cmd with program allowlist + allowWrite/allowNetwork + tree kill), view-image.js (image → attachment for provider uploadFile), index.js (dispatcher + evaluateAssistant + formatResults)
engine/tool-bridge.js — out: payload.tools[] → <mhi_tools> grammar; in: assistant MHI blocks → OpenAI tool_calls; repairPrompt on mixed/incomplete output
utils/retry.js — per-class retry: 401→1, 403→2, 429→1, 5xx→3, network/timeout→3, honors Retry-After, caps at 24h
utils/sse-writer.js — SSE with backpressure: await res drain on write(false), idempotent finish/fail, [DONE] emitted from one place
utils/diagnostics.js — bounded, redacted diagnostics; secret-key-aware object walk (access/token/cookie/…)
utils/headers.js — reads x-zerokey-* / x-opencode-* headers: session, rootSession, messageId, partId, generation
utils/log.js — central redact-before-write log; overrides console.{log,info,success,warn,error,debug,debug.mix}; each call writes console (colour) AND one redacted line to LOG_DIR/zerokey.log gated by LOG_LEVEL (levels: error 0, warn 1, info 2, debug 3, log 4); no module-level debug/error/info/warn exports remain — callers use console.* directly; only write() swallows append errors⏎engine/triggers.js — static $C trigger returns TESTING cmd; plus auto-registered $<name> per engine/extra/*.md
routes/diagnostics.js — GET /v1/diagnostics (bounded, redacted, loopback-only)
test/ — node:test suites: invariants, retry, usage, diagnostics, compaction, tool-bridge, chatgpt-recovery, mhi-{parser,path-policy,files,view-image,index}
docs/ — index.html (landing), llms.txt, .nojekyll, logos/
.github/ — PR + issue templates
.githooks/pre-commit — prettier + lint + check + test
engine/ — compiler, pipeline, instructions, syntax, triggers, loop-guard, usage, templates/, extra/, mcp/
providers/ — base/, deepseek/, claude/, chatgpt/, qwen/, registry.js
routes/ — docs, health, info, models
scripts/ — check-modules.js
surfaces/ — api, copilot, opencode, terax, vscode (auto-discovered); base.js, specs.js, registry.js are infrastructure, not surfaces
test/ — node:test suites
utils/ — cookie-jar, errors, extract-files, find-port, logger, rate-limiter, session-classifier, sse-reader, sync-ide-config, etc.
temp/ — runtime: users.json, profiles/, captures/, *.log (gitignored)

## ARCHITECTURE
server.js → sequentialQueue → prepareChatRequest (validate messages, SSE headers, classifySession) → provider router
providers/registry.js — auto-discovers providers/<name>/index.js; get(name), getAll(), getModels()
core/chat-router.js — resolves provider from registry, calls provider.buildRouter(parsedFetch, session, userData)
providers/base/BaseAPI.js — shared HTTP/cookie/agent; providers extend for per-API auth (POW, sentinel, orgId)
engine/pipeline.js — StreamPipeline: setSSEHeaders, setup(), scan() (3-state MHI FSM), flush(), onError, sendFinalChunk, writeChunk(chunk); all SSE frames go through utils/sse-writer (backpressure); final SSE chunk carries per-turn usage + cumulative session totals
engine/usage.js — normalizeUsage (6 prompt/6 completion/3 total spellings), mergeUsage (per-field max), usageOfEvent (nested shapes), buildUsage with source: upstream|mixed|estimated; accumulate(session,usage) — estimated turns only; sessionTotals(session)
providers/<name>/router.js — wraps initial chatCompletion in withRetry (utils/retry); ChatGPT additionally wraps recovery.withAuthRecovery for 401 → force reload capture + one retry
providers/chatgpt/recovery.js — withAuthRecovery, refreshSentinelSafe, forceReloadCapture, wrap; ONE_SHOT_401 latch
providers/chatgpt/stream-handler.js — counts malformedPayloads; tracks resumeToken, sawCompletionMarker, sawDoneMarker; refuses silent success on empty streams (upstream_incomplete_stream)
engine/compiler.js — ToolCompiler cached per ideName:provider; parse MHI → emit IDE-native tool call; matchSkill
engine/triggers.js — static + auto-scanned engine/extra/*.md triggers; MCP alias-map registry
engine/mcp/{auto,browser,playwright,inject}.js — MCP auto-registration + alias-map injection
engine/instructions.js — loads/caches engine/extra/*.md with SHA-256 hash
surfaces/registry.js — auto-discovers surfaces/*.js; resolveSurface(messages) via realSessionPrefix
utils/session-classifier.js — thin wrapper over surfaces registry; classifies real vs ephemeral per request

## PROVIDERS
deepseek — default TRANSPORT=browser (Playwright persistent profile, CDP insertText, page-side fetch tee); DEEPSEEK_TRANSPORT=api for legacy direct-fetch + WASM POW
claude — HAR-header ordering for Cloudflare; orgId extracted from URL; PUT /account_profile for instructions
chatgpt — sentinel proof-token config decode; UA extracted from config[4]; conduit-token refresh per turn; reinjectEvery=4
qwen — cookie token= JWT or Bearer; per-model reasoning map; reinjectEvery=15
providers/<name>/api.md — per-provider internal reference (endpoints, flow, SSE tables)

## SURFACES
vscode — prefix 'You are an expert AI programming assistant'; browserTools=true; verbose output formatters
copilot — prefix 'Follow Microsoft content policies.'; browserTools=true + browserNameMap (camelCase)
terax — prefix 'You are Terax, an AI agent'
opencode — prefix 'You are opencode'
api — no tools; fallback only (DEFAULT_SURFACE in session-classifier)

## SCHEMA
temp/users.json — legacy source of truth; read-only after first import into SQLite (see import-legacy.js). Shape: { <provider>: { <username>: { username, parsedFetch, sessions[], instructionsHash, instructionsAppliedAt, waitUntil?, waitReason? } } }
temp/zerokey.db — SQLite; sessions(provider, session_id) → upstream_conversation_id, upstream_parent_message_id, state, metadata_json; meta(k,v); legacy_import audit
temp/.start.lock — { pid, port, startedAt }; created with 'wx', released only by owner
temp/logs/zerokey.log — rotating; rotated siblings at zerokey.log.1..N (N = CONFIG.LOG_KEEP)
session — { name, chatSessionId, parentMessageId, createdAt, lastUsed, toolCalling, vision, model, dynamicToolsHash, todos, turnCount?, mcpInjected?, generation?, metadata? } (in-memory view; SQLite row is authoritative once persistent)
sessions.db row — { provider, session_id, upstream_conversation_id, upstream_parent_message_id, compaction_generation, state, metadata_json, created_at, updated_at } — PK(provider, session_id); a higher generation rebinds upstream IDs and stashes the old conversation in metadata.pendingPreviousConversationIds
usage object — { prompt_tokens, completion_tokens, total_tokens, source: 'upstream'|'mixed'|'estimated', prompt_chars?, prompt_chars_limit?, prompt_chars_headroom?, prompt_chars_dropped?, session? } — last SSE chunk only

## TOOL LOOP (rows 15+17)
Client sends body.tools[] → toolBridge.preparePayload rewrites last user message with a <mhi_tools> grammar block → provider streams text containing MHI_OPEN name MHI_SEP k=v MHI_CLOSE blocks → toolBridge.evaluateAssistant (or core/mhi.evaluateAssistant) returns { kind: 'calls', calls } → core/mhi.executeCalls runs each against the process's workspace/allowlist → results formatted as "MHI(tool): …" and appended as a user turn → next upstream round → until { kind: 'final' } or MAX_ROUNDS.
Mode selection (per request, not per process): host protocol (surface executes) when the surface's tools[] is usable; internal MHI otherwise. Never mix modes within one request.
view_image: works internally for every provider; returns { filename, mimeType, data, size, width, height } — caller passes it to provider uploadFile.
Executors are per-process: workspace root, allowlist, and capability flags read once from that process's env (ZEROKEY_WORKSPACE_ROOTS, ZEROKEY_MHI_CMD_PROGRAMS, ZEROKEY_MHI_CMD_ALLOW_WRITE, ZEROKEY_MHI_CMD_ALLOW_NETWORK, ZEROKEY_MHI_VIEW_IMAGE, ZEROKEY_MHI_FILE_TOOLS, ZEROKEY_MHI_CMD_TOOLS).

## MULTI-INSTANCE MODEL
Multi-provider, single session pinned per process. Concurrent sessions = N processes on N ports, each with its own DATA_DIR (SQLite, lock, logs) and pinned (provider, user, session). Client points at whichever port and sees one OpenAI endpoint. Providers behind each port are irrelevant to the client, and the tool shape is identical across ports. scripts/start.js refuses a start when a foreign listener already answers on CONFIG.PORT unless the health PID matches this data root's lock.

## INVARIANTS
startup — scripts/start.js is the only entrypoint; two invocations cannot both bind CONFIG.PORT (health probe + PID lock via 'wx' + post-lock probe)
port — CONFIG.EXACT_PORT default true; findPort fallback only when explicitly disabled
schema — core/state/db.js refuses a database whose schema_version exceeds SCHEMA_VERSION; never downgrades
log — every line passes utils/log.redact() before disk or stderr; no code path writes raw provider bytes
state — sessions table stores IDs and state only; prompt/response content has no columns
legacy import — import-legacy.js runs at most once (meta.legacy_import_done), never writes users.json, never overwrites existing rows
PID lock — release() unlinks only the lock owned by this process; foreign owner is not touched
session._usageTotals — { prompt_tokens, completion_tokens, total_tokens, turns } — estimated providers only (ChatGPT, Qwen); Claude/DeepSeek real usage not summed (context-window measure, not per-turn input)
MHI payload — name ¦ key=value ¦ key=value; separator U+00A6; open U+27E6; close U+27E7; esc '\'

## ENV
PORT (default 7250)
ZEROKEY_EXACT_PORT (default true — refuse a busy port)
ZEROKEY_DATA_DIR (default temp/; holds zerokey.db, .start.lock, logs/)
ZEROKEY_PROVIDER, ZEROKEY_USER, ZEROKEY_SESSION (headless startup)
DEEPSEEK_TRANSPORT (browser | api; default browser)
ZEROKEY_LOG_LEVEL, ZEROKEY_LOG_MAX_BYTES, ZEROKEY_LOG_KEEP
ZEROKEY_WORKSPACE_ROOTS (semicolon-separated allowed roots for the internal executors)
ZEROKEY_MHI_FILE_TOOLS (default true), ZEROKEY_MHI_CMD_TOOLS (default false), ZEROKEY_MHI_VIEW_IMAGE (default false)
ZEROKEY_MHI_CMD_PROGRAMS (default node;git), ZEROKEY_MHI_CMD_ALLOW_WRITE (default false), ZEROKEY_MHI_CMD_ALLOW_NETWORK (default false)

## API
GET / — server info + models
GET /health — status, uptime, provider/model/session/toolCalling/promptLimit
GET /v1/models, /v1/models/:model
POST /v1/chat/completions — SSE streaming only
GET /v1/diagnostics — bounded, redacted diagnostics (version, provider, sessions, schema_version, memory)
GET /docs (Swagger UI), GET /openapi.json
No auth — any non-empty API key accepted

## DEPENDENCIES
express ^5, node-fetch ^2, playwright ^1.63, prompts ^2 (runtime)
eslint ^10, @eslint/js ^10, prettier ^3 (dev)
pnpm-workspace.yaml — qs >=6.16.0 override

## CONFIG
config/constants.js — CONFIG.PORT
providers/<name>/config.js — models, reasoning, promptLimit, setupSteps
utils/sync-ide-config.js — writes ~/AppData/Roaming/Code/User/chatLanguageModels.json (Windows) with ZK-<port> entry
.prettierrc — singleQuote, no semi, trailingComma all, printWidth 100, LF
.githooks/pre-commit — prettier --write + lint + check + test

## TESTING (178 tests)
suites: compiler, glob, grep, loop-guard, modules, session-classifier, surfaces, invariants, retry, usage, diagnostics, compaction, tool-bridge, chatgpt-recovery, mhi-{parser,path-policy,files,view-image,index}
pnpm check — scripts/check-modules.js: loads core/engine/routes/utils/config/scripts/surfaces/providers, asserts loopback bind, exact port, schema gate, redaction (bearer/JWT/data URL/SAS/secret keys), no Unix-only assumptions in active codeoutes/utils/surfaces), session-classifier, surfaces
pnpm check — scripts/check-modules.js (loads core/engine/routes/utils)
pnpm lint — eslint . ; pnpm format — prettier --check .

## INVARIANTS
Sequential request queue — only one /v1/chat/completions in flight per process (utils/sequential-queue.js)
MHI grammar — delimiters come from engine/syntax.js only; no file restates them literally (avoids byte corruption through tool layers)
Executors are bounded — every file tool caps size (1 MiB) and output (64 KiB); grep caps files (2000), bytes (16 MiB), wall clock (10s); cmd caps args, output, and timeout, and terminates its process tree on abort/timeout
Path policy — every executor path must resolve inside ZEROKEY_WORKSPACE_ROOTS; UNC, device paths, ADS, reserved Windows names, and trailing dot/space are refused
Command capabilities — allowWrite and allowNetwork default off; a program that needs either is refused unless that flag is on; named programs resolve only under a trusted Windows root
Single provider per process — pinned at startup; restart to switch
Session pinned — restart needed to change session
users.json written atomically via .tmp + rename; full flush only on shutdown
Ephemeral requests (title-gen, tool-optimizer) clone the session, run rawMode, skip instructions/skills/MCP
Usage — real per-turn numbers only for Claude (utilization×264k) and DeepSeek (completion only, prompt=0); ChatGPT/Qwen per-turn is chars/4 estimate; only estimated turns roll into session._usageTotals
Header order matters for Claude/ChatGPT (Cloudflare fingerprint); wrap the initial chatCompletion in utils/retry.classify for bounded retry
New provider (tool channel) — if the upstream has no native tools, the pipeline emits the MHI grammar and executes blocks internally; no per-provider bridge needed
New surface — add surfaces/<name>.js exporting (t) => {...}; auto-discovered; set realSessionPrefix + tools
New skill — add entry to staticTriggers in engine/triggers.js (trigger + template + optional call)
New skill prompt file — drop engine/extra/<name>.md; auto-registers as $<name>
New internal tool — add a key to DEFINITIONS in core/mhi/parser.js, an executor branch in core/mhi/index.js, and (if it is a file op) a function in core/mhi/files.js
New provider — add providers/<name>/index.js + config.js + api.js + router.js + stream-handler.js; auto-discovered
New surface — add surfaces/<name>.js exporting (t) => {...}; auto-discovered; set realSessionPrefix + tools
New skill — add entry to staticTriggers in engine/triggers.js (trigger + template + optional call)
New skill prompt file — drop engine/extra/<name>.md; auto-registers as $<name>
MCP — tools named mcp_<server>_<tool> in req.body.tools[] auto-register as $<server>
