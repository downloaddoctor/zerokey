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
utils/log.js — central redact-before-write log; every write passes through redact()
test/invariants.test.js — loopback bind, exact port, config junk rejection, redaction, schema gate, session round-trip, no-Unix-assumptions, node:sqlite availability
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
engine/pipeline.js — StreamPipeline: setSSEHeaders, setup(), scan() (3-state MHI FSM), flush(), onError, sendFinalChunk; final SSE chunk carries per-turn usage + cumulative session totals
engine/usage.js — buildUsage (real provider numbers else chars/4 estimate marked estimated:true); accumulate(session,usage) — only estimated turns; sessionTotals(session)
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
session — { name, chatSessionId, parentMessageId, createdAt, lastUsed, toolCalling, vision, model, dynamicToolsHash, todos, turnCount?, mcpInjected? } (in-memory view; SQLite row is authoritative once persistent)
sessions.db row — { provider, session_id, upstream_conversation_id, upstream_parent_message_id, state, metadata_json, created_at, updated_at } — PK(provider, session_id)

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
ZEROKEY_PROVIDER, ZEROKEY_USER, ZEROKEY_SESSION (headless startup)
DEEPSEEK_TRANSPORT (browser | api; default browser)

## API
GET / — server info + models
GET /health — status, uptime, provider/model/session/toolCalling/promptLimit
GET /v1/models, /v1/models/:model
POST /v1/chat/completions — SSE streaming only
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

## TESTING
pnpm test — node --test test/**/*.test.js
suites: compiler, glob, grep, loop-guard, modules (loads core/engine/routes/utils/surfaces), session-classifier, surfaces
pnpm check — scripts/check-modules.js (loads core/engine/routes/utils)
pnpm lint — eslint . ; pnpm format — prettier --check .

## INVARIANTS
Sequential request queue — only one /v1/chat/completions in flight per process (utils/sequential-queue.js)
Single provider per process — pinned at startup; restart to switch
Session pinned — restart needed to change session
users.json written atomically via .tmp + rename; full flush only on shutdown
Ephemeral requests (title-gen, tool-optimizer) clone the session, run rawMode, skip instructions/skills/MCP
Usage — real per-turn numbers only for Claude (utilization×264k) and DeepSeek (completion only, prompt=0); ChatGPT/Qwen per-turn is chars/4 estimate; only estimated turns roll into session._usageTotals
Header order matters for Claude/ChatGPT (Cloudflare fingerprint)
DeepSeek browser transport is a per-username singleton — two ZeroKey processes cannot share a profile dir

## EXTENSIONS
New provider — add providers/<name>/index.js + config.js + api.js + router.js + stream-handler.js; auto-discovered
New surface — add surfaces/<name>.js exporting (t) => {...}; auto-discovered; set realSessionPrefix + tools
New skill — add entry to staticTriggers in engine/triggers.js (trigger + template + optional call)
New skill prompt file — drop engine/extra/<name>.md; auto-registers as $<name>
MCP — tools named mcp_<server>_<tool> in req.body.tools[] auto-register as $<server>
