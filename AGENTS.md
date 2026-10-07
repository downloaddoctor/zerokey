# AGENTS.md

PROJECT
 ZeroKey — self-hosted, personal-use OpenAI-compatible proxy for DeepSeek, Claude, ChatGPT, Qwen
 Turns a browser session (captured fetch()) into http://localhost:<port>/v1
 Node >=22 required; pnpm@10.13.1; CommonJS; 'use strict' at top of every module
 No telemetry, no hosted service, no shared accounts

DIRECTORY
 app.js — express app factory: pure module, no side effects; start({db,preSelected,port}) binds listeners
 server.js — only supported entrypoint; port claim → SessionSelector wizard → app.start
 config/ — CONFIG constants read once at require-time
 core/ — provider seam + MHI executor
  state/ — SQLite access (users, sessions, migrate, schema.sql)
  mhi/ — internal tool loop executors (files, commands, parser, path-policy, view-image)
 engine/ — prompt pipeline, compiler, tool bridge, triggers, MCP, extra/*.md fragments
 providers/ — one folder per provider; base/BaseAPI.js shared HTTP/cookie layer
 surfaces/ — one folder per IDE tool surface (surfaces/<name>/index.js + template.json)
 routes/ — health, models, info, docs, diagnostics
 utils/ — SSE writer/reader, rate limiter, errors, headers, log, startup, cookie-jar
 test/ — node:test suites; test/invariants.test.js and test/modules.test.js enforce repo rules
 docs/ — llms.txt, landing page; openapi.json is the machine contract

ENTRY-POINTS
 node server.js — interactive wizard
 ZEROKEY_PROVIDER=… ZEROKEY_USER=… ZEROKEY_SESSION=… node server.js — headless
 zerokey.bat / zerokey.sh — clone + install + run launcher
 pnpm start / pnpm test / pnpm lint / pnpm format / pnpm check

MODULES
 app.js — express wiring; classifySession per request; mounts health/models/diagnostics/chat router
 server.js — claimFirstFree → postClaim → db.open → SessionSelector → app.start → signal shutdown
 config/constants.js — CONFIG: PORT, PORT_RANGE, EXACT_PORT, DATA_DIR, DB_FILE, LOG_*, MHI_* capability flags
 core/chat-router.js — provider seam: adoptSession annotates the selector's Proxy row (no re-resolve, no copy); sessions.rebase runs on the per-request generation header; persistAfterTurn runs sessions.flushNow at res finish/close; server.js cleanup drains users/sessions.flushAll before store.close
 core/session-selector.js — interactive prompts: provider → user (create/update auth/delete; fetch capture) → session; headless preselection
 core/state/db.js — node:sqlite DatabaseSync; WAL; fail-closed on newer schema_version; additive columns via ADDED_COLUMNS (idempotent ALTER TABLE ADD COLUMN); one-shot legacy import
 core/state/store.js — createStore(cfg): debounced write-through + recursive Proxy (plain objects/arrays only) shared by users/sessions; cfg = table, columnMap, blobKeys, conflict, keyOf, flushMs, label
 core/state/users.js — store config + user domain fns; Proxy row; top-level and nested (parsedFetch.*, state entries) writes schedule a 250 ms debounced flush; list() also returns wrapped rows so wizard-held references persist; flushAll() drains pending writes at shutdown; deepWrap proxies only arrays and plain objects (Date/Buffer pass through)
 core/state/sessions.js — Proxy row; 250 ms debounce; nested (metadata.*, todos, usageTotals) writes also persist; flushAll() drains pending writes at shutdown; compaction via generation bump clears id/parentId
 core/mhi/loop.js — runToolLoop: one turn → evaluateAssistant → executeCalls → appendResult (role 'mhi', passed verbatim by compiler._handlers.mhi — no USER: prefix), cap MHI_MAX_ROUNDS
 core/mhi/index.js — executor dispatch; every failure returns {ok:false, code, output} — never throws except on abort
 core/mhi/files.js — read/ls/glob/grep/write/replace; write refuses overwrite; replace requires exactly one match
 core/mhi/commands.js — allowlisted programs; write/network gated by capability flags
 core/mhi/parser.js — block parser for internal executors; throws MhiParseError {code,message}
 core/mhi/path-policy.js — workspace confinement: realpath, UNC/ADS/reserved-name refusal
 core/mhi/view-image.js — falls back to context.imageRoots when the path is outside the first workspace root; other file tools stay confined to the first root
 core/mhi/loop.js imageRoots — every ZEROKEY_WORKSPACE_ROOTS entry (default process.cwd()) plus its direct parent dir (one level max, never higher); built in internalWorkspaceContext
 engine/pipeline.js — StreamPipeline: per-request SSE lifecycle, scan() FSM, deferFinish for tool loops
 engine/compiler.js — ToolCompiler singleton per ide×provider; parse/emit generic→native tool mapping
 engine/tool-bridge.js — grammar injection + block parsing for providers with no native tool channel
 engine/triggers.js — $skill registry; auto-registers one passthrough per engine/extra/*.md
 engine/instructions.js — caches base prompt + extra/*.md fragments (SHA-256)
 engine/syntax.js — OPEN/CLOSE/SEP/ESC constants and findClose/splitPayload
 engine/mcp/inject.js — inject MCP alias map into compiler.tools
 engine/mcp/auto.js — build alias maps from mcp_<server>_<tool> names in req.body.tools[]
 providers/registry.js — auto-discovers providers/<name>/index.js
 providers/<name>/index.js — {name, displayName, models, promptLimit, setupSteps, validateFetch, validateCredentials, buildRouter}
 providers/<name>/router.js — express router; runToolLoop wraps one upstream turn per round; userData is a Proxy row, mutate fields directly (persistence is automatic)
 providers/<name>/stream-handler.js — provider SSE → OpenAI chunk deltas
 providers/base/BaseAPI.js — shared base for all four *API classes: https agent, cookie jar, initializeFromJSON cookie seeding, _captureResponseHeaders (cookie header), _fetch with timeout; _seedCookies(); _timeoutError(ms) returns a plain message unless the subclass sets static JSON_TIMEOUT = true (ChatGPT/Qwen: JSON request_timeout body); subclasses add only provider-specific headers/endpoints
 surfaces/registry.js — auto-discovers surfaces/<name>/index.js; resolveSurface(messages) by realSessionPrefix; resolveUtility(messages) by utilityPrefixes
 surfaces/base.js — IDEToolSurface: tool()/format() registrar + resolve(); realSessionPrefix (real IDE fingerprint) + utilityPrefixes (IDE-internal utility calls)
 surfaces/specs.js — generic tool specs (grammar, keys, repeatable) merged by IDEToolSurface#tool()
 surfaces/openai/index.js — DEFAULT_SURFACE (realSessionPrefix null); identity-mapped tools for plain OpenAI clients; raw mode when no tools[]
 surfaces/<name>/index.js — IDE surface config fn (t) => {...}; declares ideName + realSessionPrefix + utilityPrefixes
 surfaces/<name>/template.json — captured system-prompt fingerprint for that IDE (docs/reference)
 routes/health.js — includes pid, provider, session, persistence, promptLimit
 utils/sse-writer.js — serialized SSE frames with backpressure; finish()/fail() idempotent
 utils/rate-limiter.js — sliding window 15/60s per label; setProviderCooldown on 429
 utils/startup.js — per-port lock file temp/db/.start.<port>.lock; probeHealth/postClaim
 utils/errors.js — classifyError → toOpenAIError (two calling conventions)
 utils/uuid.js — uuid() v4 via crypto.randomUUID; the only UUID helper for provider clients
 utils/http-error.js — assertOk(res, {allow, prefix}) opt-in non-OK guard (reads body slice, throws Error with .status); not used in sentinel prepare/finalize (they set err.code/statusCode) nor completion calls (bodies parsed for rate-limit/cooldown)
 utils/log.js — one zerokey.log (ts,pid,level,tag,msg,where,error,code,status,context,stack) separated by engine/syntax.js SEP (not a comma), one line per record; pid in the same column for plain and error rows; console.* rewired (colour + auto [FILE] tag + redact + mirror); console.error('msg', err[, ctx]) fills all columns — the ONE entry point; O(1) per call (cached tag, in-memory size, depth-capped causes); formatError renders Error → Name/msg|code|status + frames + caused-by

ARCHITECTURE
 Request flow: app.js middleware → sequentialQueue → prepareChatRequest → buildRouter(preSelected)
 classifySession(messages) resolves the IDE surface from the system prompt; no fingerprint + no utility → openai (real turn; pipeline decides tools via session.toolCalling)
 StreamPipeline.setup → restoreMcpInjections → compiler.uploadAndFormatPrompt → buildPrompt
 Provider router calls runToolLoop with a per-turn closure that streams via the pipeline
 One upstream turn per round; intermediate assistant text is invisible to the client (deferFinish)
 SSE [DONE] written once by pipeline.flushFinish() after the loop resolves
 Persistence: users.parsedFetch + sessions.id/parentId written through Proxy set traps, flushed on res finish/close
 Compaction: incoming x-zerokey-compaction-generation > row.generation → id/parentId cleared, old id appended to metadata.pendingPreviousConversationIds
 Fail-closed schema: db.open refuses a DB whose meta.schema_version exceeds SCHEMA_VERSION (3)
 DeepSeek uses a real Chromium profile (providers/deepseek/browser-transport.js) — not a lightweight HTTP path; new chat opens with the instruction block as warmup (_warmupPrompt), router sets haveInstructionsAPI so buildPrompt does not prepend it again; viewport null + --start-maximized (real window)

SCHEMA
 users(id PK, provider, username, parsed_fetch, instructions_hash, instructions_applied_at, wait_until, wait_reason, state_json, created_at, updated_at, UNIQUE(provider, username))
 sessions(user_id FK→users.id CASCADE, name, id, parent_id, generation, tool_calling, vision, model, todos_json, turn_count, dynamic_tools_hash, mcp_injected_json, state, metadata_json, last_token_usage, usage_totals_json, last_used, created_at, state_json, updated_at, PK(user_id,name))
 meta(key PK, value) — holds schema_version and legacy_import_done
 Column map is snake_case; JS objects camelCase via core/state/users.js and core/state/sessions.js
 Rule: lifecycle data only — never prompt or response content

ENV
 PORT (default 7250, 1..65535)
 ZEROKEY_PORT_RANGE (default 100)
 ZEROKEY_EXACT_PORT=1 — refuse a busy start port instead of moving
 ZEROKEY_DATA_DIR — default <repo>/temp
 ZEROKEY_LOG_LEVEL, ZEROKEY_LOG_MAX_BYTES, ZEROKEY_LOG_KEEP
 ZEROKEY_WORKSPACE_ROOTS — path.delimiter separated; default [process.cwd()]
 ZEROKEY_MHI_FILE_TOOLS (default true), ZEROKEY_MHI_CMD_TOOLS (default false), ZEROKEY_MHI_VIEW_IMAGE (default true)
 ZEROKEY_MHI_CMD_PROGRAMS (default node,git), ZEROKEY_MHI_CMD_PROJECT_PROGRAMS
 ZEROKEY_MHI_CMD_ALLOW_WRITE, ZEROKEY_MHI_CMD_ALLOW_NETWORK, ZEROKEY_MHI_CMD_TIMEOUT_MS, ZEROKEY_MHI_MAX_ROUNDS
 DEEPSEEK_TRANSPORT — 'browser' (default) or 'api'

DEPENDENCIES
 express@^5, node-fetch@^2 (node-fetch@2, not global fetch, for cookie/agent control)
 playwright@^1 — DeepSeek browser transport only
 prompts@^2 — startup wizard
 Runtime: node:sqlite (built-in), node:test, node:crypto
 Dev: eslint@^10, prettier@^3; .githooks/pre-commit runs `pnpm precommit`

API
 GET / — API info + available models
 GET /health — status, uptime, pid, provider, session, persistence, promptLimit
 GET /v1/models — OpenAI list shape + activeModel
 GET /v1/models/:model
 POST /v1/chat/completions — SSE stream; OpenAI-compatible
 GET /docs — Swagger UI; GET /openapi.json — raw spec
 Auth: none — any non-empty API key placeholder works
 OpenCode-flavoured headers recognised: x-zerokey-session, -root-session, -message-id, -part-id, -compaction-generation (aliases x-opencode-*)

CONFIG
 Surfaces auto-discovered from surfaces/<name>/index.js (skip registry.js, base.js, specs.js); keyed by declared ideName
 Providers auto-discovered from providers/<name>/index.js; skip providers/base/
 pnpm check runs scripts/check-modules.js
 openapi.json is hand-maintained / regenerated via scripts/gen-openapi.js (check before editing)
 classifySession(messages) → { isReal, surface, matched }:
  real IDE fingerprint wins; else utility prompt (surface-declared utilityPrefixes, matched via registry.resolveUtility) is ephemeral; else openai — a real turn (raw mode still skips instructions/skills/MCP; cloned session; real chatSessionId/parentId untouched)

BUILD
 pnpm install → postinstall sets core.hooksPath=.githooks
 pnpm start — server; pnpm test — node --test test/**/*.test.js
 pnpm lint (eslint), pnpm format (prettier check), pnpm format:fix
 pnpm precommit = format && lint && check && test — the gate .githooks/pre-commit runs
 pnpm test uses --test-reporter=dot — dots plus failure details; run `node --test` directly for the full per-test list

TESTING
 Framework: node:test with assert
 test/invariants.test.js — repo-wide invariants (naming, forbidden patterns)
 test/modules.test.js — module boundary rules; runs scripts/check-modules.js
 test/surfaces/prefixes.test.js + prefixes.snapshot.json — append-only ledger: every shipped real/utility prefix must stay declared
 test/core/mhi/* — parser, files, path-policy, view-image
 test/providers/chatgpt-recovery.test.js, test/surfaces/*, test/engine/*
 New executors must add a matching test/core/mhi/*.test.js
 Adding a surface prefix → declare in surfaces/<name>/index.js AND append to test/surfaces/prefixes.snapshot.json (same commit); never remove a shipped prefix

INVARIANTS
 One server process = one preSelected session; restart to switch session/user
 No API keys, cookies, or credential values in logs or commit messages
 Errors go through console.error('msg', err[, context]) — log.js turns that into one CSV row in zerokey.log; never stringify an Error by hand, never instantiate a LogSaver for errors
 One log file, no errors.log — the error block sits right after the lifecycle lines that led to it, so the preceding context travels with it
 Internal executors never throw on normal failure — they return {ok:false, code, output}
 Path policy: all MHI file/cmd paths confined to the resolved workspace root (realpath-checked)
 Proxy writes are debounced 250 ms; nested plain objects/arrays (parsedFetch.*, metadata.*, todos) ARE intercepted (recursive wrap) — reassignment is not required
 StreamPipeline.emit is the only path to the SSE writer
 engine/syntax.js is the single source of truth for OPEN/CLOSE/SEP/ESC — never restate the literal bytes
 No prose around tool blocks in MHI responses — mixed output triggers a repair round

EXTENSIONS
 New provider → providers/<name>/index.js exporting {name, displayName, models, promptLimit, setupSteps, validateFetch, validateCredentials, buildRouter}; registry auto-discovers
 New IDE surface → surfaces/<name>/index.js exporting (t) => {...}; set ideName + realSessionPrefix (+ realSessionPrefixAliases for older prompts) + utilityPrefixes; registry auto-discovers; test/surfaces/prefixes.test.js is append-only — never delete a shipped prefix
  Plain-OpenAI clients → surfaces/openai/index.js identity mapping; classifySession routes tools[]-bearing requests here when no IDE fingerprint matches
 New MHI executor → core/mhi/<name>.js + wire into core/mhi/index.js + test/core/mhi/<name>.test.js
 New skill → engine/triggers.js entry OR a new engine/extra/<name>.md (auto-registers as $<basename>)
 New MCP server → expose tools named mcp_<server>_<tool> in req.body.tools[]; auto-registers as $<server>
 Token-threshold reinjection → provider index.js exports reinjectAt: [{tokens, fragment}]; pipeline re-injects $<fragment> on each crossing; pipeline sets session.lastTokenUsage after every finished turn
