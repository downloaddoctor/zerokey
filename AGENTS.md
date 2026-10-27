PROJECT
 ZeroKey — self-hosted, personal-use OpenAI-compatible proxy for DeepSeek, Claude, ChatGPT, Qwen, Inception (Mercury)
 Turns a browser session (captured fetch()) into http://localhost:<port>/v1
 Node >=22.13 required; pnpm@12.14.0; CommonJS; 'use strict' at top of every module
 No telemetry, no hosted service, no shared accounts
 One server process = one preSelected provider+user+session; restart to switch

DIRECTORY
 server.js — only supported entrypoint; port lock, db open, session select, start/stop
 app.js — express app factory: pure module, no side effects; start({db,preSelected,port}) binds listeners
 config/constants.js — CONFIG, env parsed once at require; envInt/envBool/envList/envPaths helpers
 core/ — chat-router, session-selector, state/*, mhi/*
 engine/ — compiler, pipeline, triggers, syntax, instructions, usage, loop-guard, tool-bridge, mcp/*
 providers/ — one folder per provider + base/BaseAPI.js + registry.js
 surfaces/ — IDE tool surfaces + base.js + specs.js + registry.js
 routes/ — info, health, models, docs, diagnostics
 utils/ — SSE, errors, retry, cookies, log, bundle, classifier, startup
 scripts/ — build.mjs, check-modules.js, check-prefix-drift.js
 test/ — node:test suite
 docs/ — GitHub Pages site: index.html (human), machine.html (machine-readable index), llms.txt, logos/, favicon.svg
 temp/ — runtime only, gitignored: db/ logs/ profiles/ captures/ overflow/

MODULES
 server.js — startup.claimFirstFree → postClaim → db.open → SessionSelector.select → app.start; uncaughtException/unhandledRejection handlers; SIGINT/SIGTERM/SIGHUP → selector.flush → app.stop → db flush+close → release lock
 app.js — corsMiddleware rejects non-loopback Host (DNS rebinding) and enforces CONFIG.CORS_ALLOWED_ORIGINS; express.json 50mb; prepareChatRequest (validateMessages → StreamPipeline.setSSEHeaders → classifySession → req.surface/isRealSession/matchedSurface); request middleware attaches req.signal (AbortController on res.close); error handler via toOpenAIError; app.use('/v1/chat/completions', sequentialQueue(), prepareChatRequest, router)
 core/chat-router.js — buildRouter(selected, sessionContext): registry.get(provider) → adoptSession (no re-resolve, no copy) → wires session.onCaptureChanged → users.updateCapture → provider.buildRouter; per-request rebase when headers.generation > session.generation; persistAfterTurn on res finish/close
 core/session-selector.js — wizard: recent-session continue → provider → user (paste fetch, live validate) → session; waitPolicy loop for rate-limited users; _parseFetchDirect brace-scanner keeps latin1 body as bodyBase64; profile dir temp/profiles/<provider>/<user>/; delete user also deletes provider-side sessions
 core/state/db.js — sqlite-pro openDatabase; BASE_SCHEMA_VERSION=4; .version(4,'v3->v4').beforeDefine().upgrade(upgradeV3ToV4); fail-closed on newer schema
 core/state/users.js — SCHEMA; parsedFetch virtual → capture_* + user_headers rows; updateCapture(db,id,next) merges and skips unchanged headers; 250 ms debounce
 core/state/sessions.js — SCHEMA PK(userId,name); rebase() clears id/parentId and appends metadata.pendingPreviousConversationIds; resolve(); list()
 core/state/migrate-v3-v4.js — isLegacyV3 probe; rename-aside → store.define → ctx.copy → ctx.drop inside a savepoint
 core/mhi/index.js — executeCalls, evaluateAssistant (final | calls | continue), formatResults, appendResult; FILE_TOOLS set; normalizeEnablement
 core/mhi/parser.js — DEFINITIONS (read/grep/write/replace/ls/glob/view_image/cmd); parseAssistantText; parseBlock; splitCommandString; isToolCall head check; throws MhiParseError
 core/mhi/commands.js — resolveProgram (named under trusted roots via where.exe; project EXE/COM relative); classifyCapabilities (write/network per program + git subcommand); safeEnvironment; runProcess with timeout/abort/output cap; terminatePidTree via taskkill
 core/mhi/files.js — read (UTF-8 <=1 MiB, line range), ls, glob (globRegex, no symlinks, skip .git/node_modules), grep (safeSearch rejects backrefs and quantified groups; file/byte/time caps), write (new files only, atomic temp+link), replace (exactly one match, atomic rename)
 core/mhi/path-policy.js — scope(options); rejects UNC/device/ADS/reserved names/trailing dot-space; realpath escape check; existingDirectory/existingFile/newFile
 core/mhi/loop.js — runToolLoop({payload, pipeline, config, turn}); collectGrammarTools (client tools win; built-ins seeded only when client sent none); <mhi_tools> injected only on openai + new session; withAssistantTurn; round cap CONFIG.MHI_MAX_ROUNDS
 core/mhi/view-image.js — PNG/GIF/JPEG/WebP MIME + dimension sniffing; <=5 MiB; returns attachment descriptor
 core/mhi/limits.js — LIMITS single source of truth for every cap
 engine/pipeline.js — StreamPipeline: SSE lifecycle via utils/sse-writer; setup() (ephemeral/raw → registerAutoMcpServers → restoreMcpInjections → reinjectEvery → reinjectAt token thresholds → drift/loop-break fragments → uploadAndFormatPrompt → skill → buildPrompt); scan() 3-state FSM; flush() (inspectBatch, cross-turn loop break, emitToolCalls); beginTurn/sendFinalChunk/flushFinish/_finishStream (usage fold + turnCount)
 engine/compiler.js — per ide:provider singleton in ToolCompiler.objects; role handlers (system/agent/assistant/internal/instructions/live_instructions/mhi/user/tool); uploadAndGetMessages slices after the last assistant and decodes data-URI uploads; parse (keys/repeatable/anchor groups/$array); emit (transformers, todo merge, split, array); inferType; matchSkill (O(1) trigger map + matchMcpTrigger + positional #{name}# params)
 engine/triggers.js — static triggers ($req, $browser/$b, $mcp, $mcp-dump, $test, $C) + auto engine/extra/*.md passthroughs with EXTRA_OVERRIDES; MCP_ALIAS_MAPS ($browser, $playwright, auto $<server>); registerAutoMcpServers, restoreMcpInjections, matchMcpTrigger, showAvailableMcpTags, handleSkill
 engine/syntax.js — MHI OPEN/CLOSE/SEP/ESC; findClose (escape-aware); splitPayload (honours backslash escapes)
 engine/instructions.js — getExtra(name) cached per file; getFull()/getUnlimited() (instructions.md with <memory> stub replaced by agent.md); list(); SHA-256 hashes
 engine/loop-guard.js — signature() for read-only tools (ignores max/limit/till/timeout); inspectBatch; pushHistory; detectLoop; MAX_BATCH/MAX_HISTORY
 engine/usage.js — normalizeUsage/mergeUsage/usageOfEvent; buildUsage returns {source: upstream|mixed|estimated}; applyTurnUsage (upstream SETs totals, estimated ADDs)
 engine/tool-bridge.js — for surfaces with no native tool channel: preparePayload prepends <mhi_tools>; evaluateAssistant parses back to OpenAI tool_calls; coerceArguments
 engine/mcp/auto.js — groupToolsByServer (mcp_<server>_<tool>, else $native with native_ prefix); buildParamSyntax; buildAutoAliasMaps; hashTools
 engine/mcp/inject.js — injectMcpAliases(aliasMap, compilerTools, nameMap) registers _passthrough tools and returns grammar lines; extractValidKeys
 engine/mcp/browser.js, engine/mcp/playwright.js — alias maps for IDE browser tools and Playwright MCP
 engine/extra/*.md — instructions.md (full agent system prompt incl. <mhi_list>), agent.md (memory workflow), instructions-1500.md, loop-break.md, reminder.md, summary.md, test.md (17-step tool smoke test)
 providers/registry.js — auto-discovers providers/<name>/index.js; keys by providerDef.name; get/getAll/getModels
 providers/base/BaseAPI.js — impit Chrome client, CookieJar, _fetch, _buildHeaders, _timeoutError, _nodeStream
 providers/deepseek/ — default browser transport (real Chromium, temp/profiles/deepseek/<user>/), api opt-in; POW via WASM in pow.js; reinjectAt 250K/50K; waitPolicy suspension
 providers/claude/ — TRANSPORT frozen from CLAUDE_TRANSPORT (default completion); resolveTransport forces completion for legacy URL-org captures; connect-rpc.js is a self-contained protobuf/Connect codec; setClaudeInstructions PUTs account_profile; waitPolicy limit
 providers/chatgpt/ — sentinel refresh + recovery.js (401 one-shot re-decode, conversation-deleted handling); reinjectEvery 10
 providers/qwen/ — cookie token= JWT or Bearer; setQwenInstructions personalization; reinjectEvery 15; waitPolicy daily limit; no uploadFile
 providers/inception/ — authless browser transport; requiresCapture false; summaryAt 47; INCEPTION_HEADLESS; reinjectEvery 50
 surfaces/registry.js — get(ide); resolveSurface(messages) by real fingerprint; resolveUtility(messages) by utilityPrefixes; getSurface(name) for flags only
 surfaces/base.js — IDEToolSurface: realSessionPrefix, realSessionPrefixAliases, utilityPrefixes, browserTools, browserNameMap, tool(), format(), isRealSession, isUtilityPrompt, resolve(); getAllTags, filterAttachments
 surfaces/specs.js — generic specs (desc/grammar/eg/keys/repeatable/transformer/arrayFields); TODO_ARRAY_FIELDS
 surfaces/vscode/ — view/create/edit/ask/listDirectory/runCommand; editToolOutputFormatter normalizes tool messages
 surfaces/copilot/ — Copilot SDK surface; newSessionStartLength 2; strips <current_datetime>/<system_reminder>; browserNameMap camelCase; 3 utility prefixes
 surfaces/terax/ — read_file/write_file/edit/list_directory/create_directory/glob/grep/bash_run/bash_background/bash_logs/bash_kill; fetch becomes Invoke-WebRequest; no utility prefixes
 surfaces/opencode/ — read/write/edit/question/glob/grep/bash; aliases 'You are opencode', 'You are an AI agent running in OpenCode'; 5 utility prefixes
 surfaces/openai/ — default surface, realSessionPrefix null; identity mapping for all generic tools
 routes/info.js — GET / metadata + model ids
 routes/health.js — uptime, session, sessionRow, persistence (schema_version, sessions, pending writes), promptLimit, reinjectEvery
 routes/models.js — GET /v1/models, /v1/models/:model (404 via toOpenAIError)
 routes/docs.js — GET /docs (Swagger UI), /openapi.json via bundle.readAsset
 routes/diagnostics.js — GET /v1/diagnostics loopback-only redacted snapshot
 utils/sse-reader.js — readSSE(stream, {onData,onDone,onError,onBytes,onRawLine}); 1 MiB line cap
 utils/sse-writer.js — createWriter(res,{id,model}); backpressure drain; reasoning/text/toolCalls/finish/fail; joinMessages
 utils/errors.js — classifyError (session_expired, account_suspended, cloudflare_block, device_flagged, CHAT_NOT_FOUND, ...); toOpenAIError two signatures
 utils/retry.js — bounded classification (MAX_ATTEMPTS 3; 401/429 never retried; network codes); utils/with-retry.js is the single router retry wrapper + acquireSlot
 utils/rate-limiter.js — sliding 15/60s per label; setProviderCooldown, acquireSlot
 utils/sequential-queue.js — one-request-at-a-time middleware
 utils/overflow.js — limitPrompt head-keep + spill file under temp/overflow/<id>/
 utils/log.js — single SEP-delimited CSV (temp/logs/zerokey.log); rewires console.*; redact, isSecretKey, tickWait, scheduleDailyReset
 utils/diagnostics.js — depth/array/string caps + log.redact
 utils/bundle.js — ROOT, readAsset, listAssets, bundled(kind); ZK_BUNDLED=1 uses zk-assets/zk-modules
 utils/session-classifier.js — classifySession returns {isReal, surface, matched}; default openai
 utils/session-transport.js — resolveSessionTransport(session, envDefault, allowed)
 utils/headers.js — reads x-zerokey-*/x-opencode-* (session, rootSession, messageId, partId, generation)
 utils/ephemeral-session.js — clone with cleared id/parentId and deep-copied usage/history
 utils/cookie-jar.js, utils/extract-files.js (data-URI → uploads), utils/http-error.js (assertOk), utils/capture-request.js ($req), utils/har-to-capture.js, utils/human-delay.js, utils/uuid.js, utils/startup.js, utils/sync-ide-config.js, utils/route-helpers.js (validateMessages)

ARCHITECTURE
 Request flow: app.js middleware → sequentialQueue → prepareChatRequest → chat-router
 classifySession(messages) resolves the surface from the system prompt; no fingerprint and no utility → openai (real turn; pipeline decides tools via session.toolCalling)
 StreamPipeline.setup → registerAutoMcpServers → restoreMcpInjections → uploadAndFormatPrompt → buildPrompt
 Provider router calls runToolLoop with a per-turn closure that streams through the pipeline
 One upstream turn per round; intermediate assistant text is invisible to the client (deferFinish)
 SSE [DONE] written once by pipeline.flushFinish() after the loop resolves
 Persistence: users.parsedFetch and sessions.id/parentId written through Proxy set traps, flushed on res finish/close
 Compaction: incoming x-zerokey-compaction-generation > row.generation → id/parentId cleared, old id appended to metadata.pendingPreviousConversationIds
 Fail-closed schema: db.open refuses a DB whose meta.schema_version exceeds BASE_SCHEMA_VERSION (4); older DBs upgraded in place by migrate-v3-v4
 Provider is fixed for the process lifetime; no runtime switching; registry.get() is the seam
 Bundled build replaces filesystem scans via utils/bundle.bundled()

SCHEMA
 users(id PK, provider, username, capture_url, capture_method, capture_body, capture_body_base64, capture_extra, instructions_hash, instructions_applied_at, wait_until, wait_reason, created_at, updated_at, UNIQUE(provider, username))
 user_headers(user_id FK→users.id CASCADE, name, value, pos, PK(user_id,name), WITHOUT ROWID) — one row per captured request header; name keeps captured case, pos keeps order
 sessions(user_id FK→users.id CASCADE, name, id, parent_id, generation, tool_calling, vision, model, transport, todos_json, turn_count, dynamic_tools_hash, mcp_injected_json, state, metadata_json, last_token_usage, usage_totals_json, last_used, created_at, updated_at, PK(user_id,name)); index idx_sessions_user: userId,-lastUsed
 meta(key PK, value) — holds schema_version only
 Column map is snake_case; JS objects camelCase via core/state/users.js and core/state/sessions.js
 Rule: lifecycle data only — never prompt or response content
 Proxy writes are debounced 250 ms; nested plain objects/arrays (parsedFetch.*, metadata.*, todos) ARE intercepted (recursive wrap)

ENV
 PORT (default 7250, 1..65535)
 ZEROKEY_PORT_RANGE (default 100)
 ZEROKEY_EXACT_PORT=1 — refuse a busy start port instead of moving
 ZEROKEY_DATA_DIR — default <repo>/temp
 ZEROKEY_ALLOWED_ORIGINS — comma-separated CORS allowlist (default '*'); enforced by corsMiddleware in app.js
 ZEROKEY_LOG_LEVEL, ZEROKEY_LOG_MAX_BYTES, ZEROKEY_LOG_KEEP
 ZEROKEY_WORKSPACE_ROOTS — path.delimiter separated; default [process.cwd()]
 ZEROKEY_MHI_FILE_TOOLS (default true), ZEROKEY_MHI_CMD_TOOLS (default false), ZEROKEY_MHI_VIEW_IMAGE (default true)
 ZEROKEY_MHI_CMD_PROGRAMS (default node,git), ZEROKEY_MHI_CMD_PROJECT_PROGRAMS
 ZEROKEY_MHI_CMD_ALLOW_WRITE, ZEROKEY_MHI_CMD_ALLOW_NETWORK, ZEROKEY_MHI_CMD_TIMEOUT_MS, ZEROKEY_MHI_MAX_ROUNDS (8)
 DEEPSEEK_TRANSPORT — 'browser' (default) or 'api'
 INCEPTION_TRANSPORT — 'browser' (default) or 'api'; INCEPTION_HEADLESS — 1|true runs headless
 CLAUDE_TRANSPORT — 'completion' (default) or 'rpc' (opt-in; blocked on f15 signer)
 ZEROKEY_CLAUDE_F15_PROBE — 'zero'|'random': debug only; unset → actionSignature() throws
 ZEROKEY_PROVIDER / ZEROKEY_USER / ZEROKEY_SESSION — headless boot
 ZK_BUNDLED=1 — dist bundle, uses virtual modules

DEPENDENCIES
 express@^5, impit@^0.14 (all provider HTTP via BaseAPI._client: Chrome TLS/HTTP2 fingerprint; _nodeStream wraps the WHATWG body as a Node Readable)
 playwright@^1 — DeepSeek + Inception browser transports
 prompts@^2 — startup wizard
 Runtime: node:test, node:crypto; sqlite via sqlite-pro (npm)
 Dev: eslint@^10, prettier@^3; .githooks/pre-commit runs `pnpm precommit`

API
 GET / — API info + available models
 GET /health — status, uptime, pid, provider, session, persistence, promptLimit
 GET /v1/models — OpenAI list shape + activeModel
 GET /v1/models/:model
 GET /v1/diagnostics — loopback-only redacted snapshot
 POST /v1/chat/completions — SSE stream; OpenAI-compatible
 GET /docs — Swagger UI; GET /openapi.json — raw spec
 Auth: none — any non-empty API key placeholder works; loopback Host only
 Public docs (GitHub Pages): docs/index.html (human), docs/machine.html (machine index), docs/llms.txt — no build step, plain static files; keep version/stack/provider rows in sync with package.json
 OpenCode-flavoured headers recognised: x-zerokey-session, -root-session, -message-id, -part-id, -compaction-generation (aliases x-opencode-*)
 openapi.json is hand-maintained (no generator script); keep x-reasoning-labels and x-prompt-limits in sync with providers/<name>/config.js

CONFIG
 Surfaces auto-discovered from surfaces/<name>/index.js (skip registry.js, base.js, specs.js); keyed by declared ideName
 Providers auto-discovered from providers/<name>/index.js; skip providers/base/
 classifySession(messages) → {isReal, surface, matched}: real IDE fingerprint wins; else utility prompt (surface utilityPrefixes) is ephemeral; else openai — a real turn; ephemeral utility requests answered locally with an empty [DONE], never sent upstream
 pnpm check runs scripts/check-modules.js
 pnpm check:prefixes runs scripts/check-prefix-drift.js — verifies watched upstream prompt prefixes (sources in prefixes.sources.json); network needed, not in precommit

BUILD
 pnpm build — scripts/build.mjs: esbuild bundles own code to dist/server.js (npm packages external, define process.env.ZK_BUNDLED=1); virtual modules zk-assets (openapi.json, deepseek wasm, engine/extra/*.md as base64) and zk-modules (providers/surfaces static lists); dist/ also gets slim package.json + pnpm-lock.yaml + pnpm-workspace.yaml + version.txt; bundle is minified with a linked sourcemap
 utils/bundle.js — seam: ROOT, readAsset, listAssets, bundled; disk-backed from source, bundle-backed when ZK_BUNDLED=1; new runtime file reads must go through it
 .github/workflows/release.yml — on push to main when runtime-relevant paths change: esbuild (version from package.json, single source) + smoke test (dist files exist, node --check dist/server.js) + node scripts/build.mjs; publishes dist/* + SHA256SUMS as a GitHub Release (tag v<version>-<sha8>)
 .github/workflows/pages.yml — on docs/** changes: deploys docs/ to GitHub Pages
 pnpm install → postinstall sets core.hooksPath=.githooks
 pnpm start — server; pnpm test — node --test test/**/*.test.js
 pnpm lint (eslint), pnpm format (prettier check), pnpm format:fix
 pnpm precommit = format && lint && check && test — the gate .githooks/pre-commit runs

TESTING
 Framework: node:test with assert
 test/invariants.test.js — repo-wide invariants (naming, forbidden patterns)
 test/modules.test.js — module boundary rules; runs scripts/check-modules.js
 test/surfaces/prefixes.test.js + prefixes.snapshot.json — append-only ledger: every shipped real/utility prefix must stay declared
 test/core/mhi/* — parser, files, path-policy, view_image, commands, cmd-multi, index
 test/core/state/* — users, sessions, compaction, migrations, schema round-trips
 test/providers/* — chatgpt-recovery, claude-connect-rpc, claude-org-id, claude-stream-handler, inception*
 test/surfaces/*, test/engine/*, test/utils/*
 New executors must add a matching test/core/mhi/*.test.js
 Adding a surface prefix → declare in surfaces/<name>/index.js AND append to test/surfaces/prefixes.snapshot.json (same commit); never remove a shipped prefix
 pnpm test uses --test-reporter=dot; run `node --test` directly for the full per-test list

INVARIANTS
 No API keys, cookies, or credential values in logs or commit messages
 Errors go through console.error('msg', err[, context]) — log.js turns that into one CSV row in zerokey.log; never stringify an Error by hand
 temp/logs/sessions/session-<N>.log — per-process log (all levels incl. debug), N zero-padded to 3 digits; read it FIRST when the user names a session
 Internal executors never throw on normal failure — they return {ok:false, code, output}
 Path policy: all MHI file/cmd paths confined to the resolved workspace root (realpath-checked)
 cmd/view_image gated by CONFIG flags; commands restricted to the configured program allowlists plus write/network capability gates
 StreamPipeline.emit is the only path to the SSE writer
 engine/syntax.js is the single source of truth for OPEN/CLOSE/SEP/ESC — never restate the literal bytes
 No prose around tool blocks in MHI responses — mixed output triggers a repair round
 app.js has no side effects on require; only start() binds a port
 Surface identity comes only from the system-prompt fingerprint — no header or client claim
 IDE-internal utilities are always ephemeral and never write into a session
 _finishStream is the single stream exit; finish/fail are idempotent
 Tool-loop [DONE] deferred until the loop resolves (deferFinish)

EXTENSIONS
 New provider → providers/<name>/index.js exporting {name, displayName, models, reasoning, promptLimit, setupSteps, createAPI, validateFetch, validateCredentials, buildRouter} (+ optional transports, waitPolicy, reinjectEvery, reinjectAt, requiresCapture, defaultVision); registry auto-discovers; requiresCapture=false skips fetch capture and validateCredentials always passes
 New IDE surface → surfaces/<name>/index.js exporting (t) => {...}; set ideName + realSessionPrefix (+ realSessionPrefixAliases for older prompts) + utilityPrefixes; registry auto-discovers; prefixes ledger is append-only
 Plain-OpenAI clients → surfaces/openai/index.js identity mapping; classifySession routes tools[]-bearing requests here when no IDE fingerprint matches
 New MHI tool → spec in surfaces/specs.js, executor in core/mhi/, dispatch in core/mhi/index.js, DEFINITIONS in core/mhi/parser.js, test in test/core/mhi/
 New skill → engine/triggers.js entry OR a new engine/extra/<name>.md (auto-registers as $<basename>)
 New MCP server → expose tools named mcp_<server>_<tool> in req.body.tools[]; auto-registers as $<server>
 Token-threshold reinjection → provider index.js exports reinjectAt: [{tokens, fragment}]; pipeline re-injects $<fragment> on each crossing
 New env var → parse in config/constants.js (envInt/envBool/envList/envPaths) and document here
 New schema column → additive is free (no version bump); destructive needs a new .version(n) ladder step in core/state/db.js
