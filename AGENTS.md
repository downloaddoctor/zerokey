# ZeroKey

## PROJECT
 OpenAI-compatible AI proxy for DeepSeek, Claude, ChatGPT & Qwen — no API keys, real browser sessions
 Node.js >= 18, Express 5, pnpm, SSE streaming
 Auth: user pastes a browser fetch() capture; proxy replays real session cookies
 Session model: one server process pinned to the session selected at startup

## DIRECTORY
 config/
  constants.js # CONFIG only (PORT); model/reasoning/prompt-limit data lives in providers/<name>/config.js
 core/
  chat-router.js # buildRouter(selected) → registry.get(selected.provider).buildRouter(...)
  session-selector.js # SessionSelector — TUI wizard; provider-agnostic via registry.get(provider)
 engine/
  syntax.js # SYNTAX tokens (OPEN/CLOSE/SEP/ESC) + findClose, splitPayload
  compiler.js # ToolCompiler — singleton per IDE×provider; uploadAndGetMessages, uploadAndFormatPrompt, uploadAndFormatPromptForRaw, buildPrompt, compile/parse/emit, matchSkill
  instructions.js # Instructions — lazy-loads instructions.md + skills-extra.md, hash for change detection
  instructions.md # Base system prompt (agent rules, MHI syntax, execution model, output contract)
  skills-extra.md # Extra prompt appends (tool grammar, dynamic-tools listing)
  pipeline.js # StreamPipeline — SSE head: scanning, emitting, MCP injection, skill handling, error formatting
  tool-defs.js # TOOLS — generic tool grammar + per-IDE mappings (vscode, terax, opencode), output shorteners
  triggers.js # Skills + MCP auto-registration/passthrough/restore
  mcp/
   browser.js # BROWSER_MCP — built-in browser MCP alias map
   playwright.js # PLAYWRIGHT_MCP — Playwright MCP alias map
   inject.js # injectMcpAliases — registers MCP tools into compiler.tools
   auto.js # buildAutoAliasMaps, hashTools — auto-registration from mcp_<server>_<tool> naming
  templates/
   vscode.json # VS Code tool schemas (source for engine/tool-defs.js)
   terax.json # Terax tool schemas
   opencode.json # OpenCode tool schemas
 providers/
  registry.js # ProviderRegistry — auto-discovers providers/<name>/index.js; get/getAll/getNames/getModels (flattened {id:model} map)
  base/
   BaseAPI.js # shared provider API base class (used by claude/deepseek)
  deepseek/
   index.js # provider def: {name,displayName,models,reasoning,promptLimit,setupSteps,defaultVision,createAPI,validateCredentials,validateFetch,buildRouter}
   router.js # buildDeepSeekRouter — picks transport via env DEEPSEEK_TRANSPORT (default 'browser', alt 'api')
   browser-transport.js # DeepSeekBrowserTransport — drives chat.deepseek.com via persistent-profile Chromium per user (temp/profiles/deepseek/<username>); page-side fetch/XHR tee; CDP Input.insertText for prompt delivery
   config.js # models, reasoning, promptLimit, setupSteps
   api.js # DeepSeekAPI — direct-fetch transport (PoW, cookie jar)
   pow.js # DeepSeekPOW — WASM sha3 solver
   stream-handler.js # SSE fragment router (THINK→reasoning_content, RESPONSE→scan)
   api.md # upstream endpoints, POW flow, SSE event table, session shape
   wasm/ # sha3 wasm asset
  claude/
   index.js # provider def
   api.js # ClaudeAPI extends BaseAPI
   router.js # buildClaudeRouter
   set-instructions.js # writes conversation_preferences via /api/account_profile (hash-gated)
   stream-handler.js # SSE (thinking_delta→reasoning_content, text_delta→scan)
   config.js # models, reasoning, promptLimit, setupSteps
   api.md # internal reference (HAR header order, usage-limit handling, SSE format)
  chatgpt/
   index.js # provider def
   api.js # ChatGPTAPI — standalone (sentinel POW, conduit token)
   pow.js # ChatGPTProofOfWork — SHA3-512 sentinel solver
   router.js # buildChatGPTRouter
   stream-handler.js # SSE (o/p/v patch stream)
   config.js # models, reasoning, promptLimit, setupSteps
   api.md # internal reference
  qwen/
   index.js # provider def
   api.js # QwenAPI — standalone (cookie token=JWT)
   router.js # buildQwenRouter
   set-instructions.js # writes personalization.instruction via /api/v2/users/user/settings/update (hash-gated)
   stream-handler.js # SSE (phase=think/answer, say-tool unwrap)
   config.js # models, reasoning, promptLimit, setupSteps
   api.md # internal reference
 routes/
  docs.js # GET /openapi.json (serves repo-root openapi.json), GET /docs (Swagger UI via unpkg CDN)
  info.js # GET / — API info
  health.js # GET /health — uptime, user, provider, model
  models.js # GET /v1/models, GET /v1/models/:model
 utils/
  cookie-jar.js # CookieJar — seed/capture/serialize
  errors.js # classifyError, toOpenAIError
  extract-files.js # decodeContentParts — base64 data-URI → Buffer[]
  find-port.js # findPort, isPortActive
  capture-request.js # captureRequest — dumps req.body to temp/captures/*.json ($req skill)
  ephemeral-session.js # ephemeralSession — clone with chatSessionId/parentMessageId nulled
  sequential-queue.js # sequentialQueue — serializes every /v1/chat/completions request app-wide
  human-delay.js # humanDelay — randomized 3-9s delay before provider chatCompletion
  session-classifier.js # isRealChatSession — per-IDE system-prompt prefix match
  logger.js # console color wrappers; tickWait(label,ms)
  log-saver.js # LogSaver (rotating file logger); serializeError
  rate-limiter.js # acquireSlot, setProviderCooldown — 15 req/60s window per label
  route-helpers.js # validateMessages
  sse-reader.js # readSSE — handles both node-fetch (Node Readable) and native fetch (WHATWG stream)
  sync-ide-config.js # syncIdeConfig — writes ZeroKey model entry into VS Code chatLanguageModels.json
 scripts/
  check-modules.js # require-loads every .js under core/ engine/ routes/ utils/
 docs/ # published landing page (eslint-ignored)
 temp/ # runtime: users.json, captures/, profiles/, logs (gitignored)
 zerokey.bat # Windows launcher: portable toolchain into .zerokey-tools\, clone/update/run
 zerokey.sh # Unix launcher: apt/dnf/yum/pacman/apk/brew, --prod installs

## ENTRY-POINTS
 server.js # node server.js / pnpm start
 zerokey.bat / zerokey.sh # bootstrap wrapper around server.js

## SKILLS
 Triggers (engine/triggers.js): $cwd, $save, $req, $browser($B), $mcp, $mcp-dump, $test, $tools($T), $R, $summary($S)
 Aliases share one entry via skill.aliases[], registered in compiler.js skillsByTrigger
 $tools re-emits instructions.md; $browser/$playwright are passthrough (vscode-only)

## MODULES
 server.js
  → express
  → routes/{docs,info,health,models}, core/chat-router
  → core/session-selector
  → utils/{find-port,sync-ide-config,logger,errors,sequential-queue,log-saver}
 chat-router.js
  → providers/registry → providers/<name>/router.js
 session-selector.js
  → prompts (TUI)
  → providers/registry (createAPI/validateCredentials/setupSteps/models/reasoning/waitPolicy/defaultVision)
 registry.js
  → providers/<name>/index.js (auto-discovered)
 providers/<name>/router.js
  → engine/pipeline (StreamPipeline)
  → providers/<name>/api, providers/<name>/stream-handler
  → providers/<name>/set-instructions (claude/qwen only)
  → utils/{rate-limiter,route-helpers}
 pipeline.js
  → engine/compiler (ToolCompiler)
  → engine/syntax
  → engine/triggers (restoreMcpInjections, showAvailableMcpTags, handleSkill)
  → utils/{errors,session-classifier,ephemeral-session}
 compiler.js
  → engine/{instructions,tool-defs,syntax}
  → engine/triggers (matchMcpTrigger)
  → utils/extract-files

## RUNTIME-GRAPH
 startup:
  server.js → findPort → SessionSelector.select (TUI wizard)
  → syncIdeConfig (VS Code chatLanguageModels.json)
  → buildRouter(selected) mounted at /v1/chat/completions
 per-request (POST /v1/chat/completions):
  sequentialQueue middleware serializes all requests (one in flight at a time)
  → new StreamPipeline(res, session, provider, ide, messages)
   → isRealChatSession(ide, messages) classifies real vs ephemeral utility call
    → real: pipeline.session = session, rawMode = !toolCalling
    → ephemeral: pipeline.session = ephemeralSession(session), rawMode = true
   → route sets pipeline.onFinalChunk (ephemeral only) to delete the provider-side session
  → pipeline.setup(messages, tools, req):
   ephemeralMode → uploadAndFormatPromptForRaw(..., false)
   rawMode      → uploadAndFormatPromptForRaw(..., true)
   else         → registerAutoMcpServers + restoreMcpInjections + uploadAndFormatPrompt + buildPrompt
  → acquireSlot(label)
  → providerApi.chatCompletion → stream
  → streamHandler → pipeline.scan → emit (MHI tool-call parsing or raw passthrough)
  → pipeline.sendFinalChunk → session.lastUsed updated → onFinalChunk fires if set

## SCHEMA
 POST /v1/chat/completions
  body: { model, messages[], tools?, reasoning_effort? }
  content parts: { type:"image_url", image_url:{ url:"data:mime;base64,..." } } | { type:"file", file:{ file_data:"data:mime;base64,...", filename } }
  response: SSE of OpenAI chunk { id, object:"chat.completion.chunk", created, model, choices:[{ delta, finish_reason }] }
 GET /v1/models → { object:"list", data:Model[], activeModel }
 GET /health → { status, uptime, timestamp, username, provider, model }
 Auth header: Authorization: Bearer <vscode|terax|opencode> (default: vscode)
 temp/users.json:
  { <provider>: { <username>: { username, parsedFetch, sessions[], instructionsHash?, waitUntil?, waitReason?, dynamicToolsHash?, mcpInjected?, todos? } } }

## ENV
 PORT # default 7250
 DEEPSEEK_TRANSPORT # 'browser' (default) | 'api'
 EDITOR # used by SessionSelector._openEditor on non-Windows

## DEPENDENCIES
 runtime: express ^5.2.1, node-fetch ^2.7.0, playwright ^1.63.0, prompts ^2.4.2
 dev: @eslint/js ^10, eslint ^10, prettier ^3.9.6
 pnpm 10.13.1 (packageManager); overrides qs >=6.16.0

## CONFIG
 .prettierrc — singleQuote, no semi, trailingComma=all, LF, width 100, tab 2
 eslint.config.js — flat config, ignores node_modules/temp/worktemp/docs
 .githooks/pre-commit — format:fix + git add + lint + check (wired via core.hooksPath; postinstall re-wires on clone)
 config/constants.js — CONFIG.PORT (env PORT or 7250)
 providers/<name>/config.js — models, reasoning, promptLimit, setupSteps (single source per provider)
 providers/registry.js — getModels() flattens all providers into { id: Model }

## BUILD
 none (runs from source)
 start: node server.js

## TESTING
 pnpm check → scripts/check-modules.js
 pnpm lint, pnpm format

## KNOWN-INVARIANTS
 registry.getModels() keyed by meta.id (slug), not display name; id = canonical slug, name = display label
 DeepSeek uses a single unified model `default` (model_type: default) — thinking + search + vision; PoW per request (WASM sha3); retries on SSE error exactly once
 DeepSeek browser transport: getSharedTransport({username}) lazy singleton; profile dir single-instance (cannot share with Playwright MCP or run two server processes concurrently); uploadFile drives hidden <input type=file> and polls Send re-enable; parent_message_id server-assigned (transport drops it); DeepThink/Search toggles best-effort via div.ds-toggle-button
 Claude auth: cookie; body uses completion_request_id (UUID) + effort + thinking_mode (not thinking_enabled); thinking blocks → reasoning_content deltas
 Claude reasoning: provider labels ['Low','Low Think','Medium','Medium Think','High','High Think','Max','Max Think']; Haiku override reasoning:['No Think','Think'] → thinking_mode:'extended'|'off', no effort tier; per-model enforcement in router
 Qwen auth via cookie `token=<jwt>` (authorization Bearer optional); validated by throwaway chat create+delete in QwenAPI.getCurrentUser()
 Qwen reasoning labels ['Auto','Think','Fast']; O(1) map → feature_config (thinking_enabled, auto_thinking, thinking_mode, thinking_format, auto_search); Fast omits thinking_format; per-model restrictions enforced in router (qwen3.7-max ['Think','Fast'], qwen3.5-omni-plus []); unsupported → first allowed
 Qwen selectMessage POST /api/v2/chats/:chatId/messages/select after stream finishes (non-critical, failures ignored)
 sync-ide-config.js: reads modelConfig.reasoning first (per-model), falls back to providerDef.reasoning.labels; writes thinking:true when supportsReasoning; seeds model.defaultReasoning into settings[modelId].reasoningEffort
 ToolCompiler is a singleton per IDE×provider (cached in ToolCompiler.objects)
 Session state (chatSessionId, parentMessageId, lastUsed, todos) mutated in-memory; persisted to users.json only on shutdown via selector.flush()
 SessionSelector is provider-agnostic (no provider-name string comparisons); delegates validateFetch/validateCredentials/waitPolicy/defaultVision to registry
 StreamPipeline defers tool-call emission for terax/opencode (batched at flush), emits immediately for vscode; rawMode skips MHI parser entirely
 Rate limiter: 15 req/60s per label; provider 429 → setProviderCooldown(label, ms); ChatGPT default cooldown = time to next UTC hour
 ChatGPT 403 with "unusual activity" → device/IP flagged (category device_flagged), 1-min cooldown; distinct from 401/403 session_expired
 Error logs: temp/errors.log (1MB rotation); temp/{deepseek,claude,chatgpt,qwen}-error.log (100KB rotation)
 sequentialQueue serializes every /v1/chat/completions request app-wide; no concurrent handling
 Ephemeral chat sessions deleted provider-side via pipeline.onFinalChunk, fired from sendFinalChunk