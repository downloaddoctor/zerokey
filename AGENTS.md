# ZeroKey

## PROJECT
 OpenAI-compatible AI proxy for DeepSeek, Claude, ChatGPT & Qwen — no API keys, real browser sessions
 Node.js >= 18, Express 5, pnpm, SSE streaming

## DIRECTORY
 config/
  constants.js # CONFIG only (PORT) — model/reasoning/prompt-limit data lives in providers/<name>/config.js
 providers/
  registry.js # ProviderRegistry — auto-discovers providers/<name>/index.js, exposes get/getAll/getNames/getModels (flattened {id:model} map, same shape as legacy MODELS)
  base/
   BaseAPI.js # BaseAPI — shared provider API base class
   BaseRouter.js # BaseRouter — shared route-builder base class
   BaseStreamHandler.js # BaseStreamHandler — shared SSE stream-handler base class
  deepseek/
   index.js # provider def: {name,displayName,models,reasoning,promptLimit,setupSteps,createAPI,validateCredentials,buildRouter}
   router.js # buildDeepSeekRouter — picks transport via env DEEPSEEK_TRANSPORT (default 'browser', alt 'api')
   browser-transport.js # DeepSeekBrowserTransport — drives chat.deepseek.com via persistent-profile Chromium (temp/deepseek-transport-profile); same surface as DeepSeekAPI; taps /api/v0/chat/completion response only (no request interception); buffers SSE body to a Readable for stream-handler

   # Browser transport: session model
   #   new chat      → createChatSession() clicks "New chat", sends warmup prompt, reads UUID from URL /a/chat/s/<uuid>
   #   existing chat → chatCompletion() navigates to https://chat.deepseek.com/a/chat/s/<chatSessionId> (original link) if not already there; UI auto-opens the thread, composer reuses it
   #   warmupSession() is a no-op (warmup runs inside createChatSession)
   #
   # Browser transport: streaming (v3)
   #   Page-side fetch/XHR tee installed via context.addInitScript BEFORE navigation — tees ReadableStream, forwards one branch to app, pushes the other back to Node via exposeFunction (__dsChunk/__dsDone/__dsError)
   #   Chosen over CDP Fetch (v2): Fetch at Response stage unreliable for text/event-stream (no requestPaused until body begins, IO.read/continueResponse race); page tee has none of those problems
   #   Prompt delivery: CDP Input.insertText (atomic, multi-KB safe) — page.keyboard.type() drops chars on large prompts; no clipboard permissions needed
   #   Navigation: _gotoFast() uses waitUntil:'commit' (not domcontentloaded) — DeepSeek SPA boot is slow; composer readiness checked separately via _waitForComposer()
   #   Launch flags: --no-first-run, --disable-session-crashed-bubble, --disable-background-networking, --disable-sync etc. — kill Chromium's profile-side background work that stalled launch
   #   Do NOT request clipboard permissions: they are negotiated at launch and add 30s+ before the first navigation; Input.insertText doesn't use the clipboard anyway
   #
   # Browser transport: limitations (v3)
   #   uploadFile() throws — DOM file-picker flow not implemented; ref_file_ids always []
   #   parent_message_id ignored — server assigns it; router passes stale value, transport drops it
   #   profile dir is single-instance — cannot run two server processes or share with Playwright MCP concurrently
   #   toggles (DeepThink/Search) are best-effort — matched by role=button + text; verify aria-pressed/class heuristics if state drifts
   #
   # Browser transport: human delay
   #   humanDelay() (utils/human-delay.js, 3-9s randomized) runs at the chatCompletion() — parity with the direct-API DeepSeekAPI
   #
   # Browser transport: shared instance
   #   getSharedTransport() — module-level singleton used by BOTH validateCredentials (wizard) and router (runtime)
   #   only one Chromium may hold temp/deepseek-transport-profile, so both must go through the same instance
   #   TRANSPORT switch (DEEPSEEK_TRANSPORT) is read by both index.js and router.js — keep them in sync
   config.js # models, reasoning, promptLimit, setupSteps
   api.md # internal reference: upstream endpoints, POW flow, SSE event table, session shape (direct-API transport, kept for validateCredentials + DEEPSEEK_TRANSPORT=api)
  claude/
   index.js # provider def (same shape as deepseek/index.js)
   router.js # buildClaudeRouter
   config.js # models, reasoning, promptLimit, setupSteps
   api.md # internal reference: HAR header order, usage-limit handling, SSE format, session shape
  chatgpt/
   index.js # provider def
   router.js # buildChatGPTRouter
   config.js # models, reasoning, promptLimit, setupSteps
   api.md # internal reference: sentinel POW flow, HAR header order, SSE format, session shape
  qwen/
   index.js # provider def
   router.js # buildQwenRouter
   config.js # models, reasoning, promptLimit, setupSteps
   api.md # internal reference: auth (cookie token=JWT), upstream endpoints, flow, session shape
 core/
  chat-router.js # buildRouter(selected) → registry.get(selected.provider).buildRouter(...)
  session-selector.js # SessionSelector — TUI wizard for provider/user/session, live-credential validation, rate-limit awareness, user deletion (local + provider cleanup); pulls setupSteps/models/reasoning via registry.get(this.provider)
 engine/
  syntax.js # SYNTAX tokens (OPEN/CLOSE/SEP/ESC) + findClose, splitPayload — backslash-escaped block/param parsing shared by compiler.js and pipeline.js¦new_check
  compiler.js # ToolCompiler — singleton per IDE×provider: uploadAndGetMessages, uploadAndFormatPrompt, uploadAndFormatPromptForRaw, buildPrompt, compile/parse/emit, matchSkill
  instructions.js # Instructions — lazy-loads instructions.md + skills-extra.md, hash for change detection
  instructions.md # Base system prompt (agent rules, MHI syntax, execution model, output contract)
  pipeline.js # StreamPipeline — SSE stream head: scanning (via SYNTAX.findClose/splitPayload), emitting, MCP injection, skill handling, error formatting
  skills-extra.md # Extra prompt appends (tool grammar, dynamic-tools listing)
  tool-defs.js # TOOLS — generic tool grammar + per-IDE mappings (vscode, terax, opencode), output shorteners
  triggers.js # Skills: $cwd, $save, $req, $browser($B), $mcp, $mcp-dump, $tools($T), $R, $test, $summary($S); MCP auto-registration, passthrough, restore
 mcp/
  browser.js # BROWSER_MCP — built-in browser MCP alias map
  inject.js # injectMcpAliases — registers MCP tools into compiler.tools
  auto.js # buildAutoAliasMaps, hashTools — auto-registration from mcp_<server>_<tool> naming
  playwright.js # playwrightMCP — Playwright MCP alias map
 routes/
  docs.js # GET /openapi.json (serves repo-root openapi.json), GET /docs (Swagger UI via unpkg CDN)
  info.js # GET / — API info, models: Object.keys(registry.getModels())
  health.js # GET /health — uptime, user, provider, model
  models.js # GET /v1/models, GET /v1/models/:model — OpenAI-compatible model listing, sourced from registry.getModels()
 openapi.json # OpenAPI 3.1 spec — public contract for /, /health, /v1/models, /v1/models/:model, /v1/chat/completions; x-ide-support/x-reasoning-labels/x-prompt-limits extensions
 utils/
  cookie-jar.js # CookieJar — shared cookie store, seed/capture/serialize
  errors.js # classifyError, toOpenAIError — provider error → OpenAI-compatible error
  extract-files.js # decodeContentParts — base64 data-URI → Buffer[] for file upload
  find-port.js # findPort, isPortActive — port scanning
  har-to-capture.js # harToCapture — HAR JSON → network-capture format
  capture-request.js # captureRequest — dumps req.body to temp/captures/*.json ($req skill)
  ephemeral-session.js # ephemeralSession — clones session with chatSessionId/parentMessageId nulled, for ephemeral/utility calls
  sequential-queue.js # sequentialQueue — Express middleware serializing all requests through one app instance, one in flight at a time
  human-delay.js # humanDelay — randomized delay (default 3-9s) used before every provider chatCompletion and session-create call where applicable; → utils/logger (tickWait)
  session-classifier.js # isRealChatSession — per-IDE fingerprinted system-prompt prefix match; default-deny classifies non-matching system-first calls as ephemeral
  logger.js # console color wrappers (debug, info, success, warn, error); tickWait(label,ms) — shared \r countdown display, returns stop fn
  log-saver.js # LogSaver — rotating file logger (temp/<name>.log, size-based rotation, optional beforeSave); serializeError flattens Error → JSON (name/message/stack/status/statusCode/code/type/cause/cooldownMs + own props)
  rate-limiter.js # acquireSlot — per-provider rate limiting (15 req / 60s window); → utils/logger (tickWait)
  route-helpers.js # validateMessages — shared route middleware
  sse-reader.js # readSSE — generic SSE stream reader for both Web and Node streams
  sync-ide-config.js # syncIdeConfig — writes ZeroKey model entry into VS Code chatLanguageModels.json; also writes model.defaultReasoning into zeroKeyEntry.settings[modelId].reasoningEffort (deletes key/entry if absent)
 scripts/
  check-modules.js # Dependency integrity check

## SKILLS
 Skill triggers (engine/triggers.js): $cwd, $save, $req, $browser($B), $mcp, $mcp-dump, $test, $tools($T), $R, $summary($S). Aliases share one trigger entry via skill.aliases[], registered in compiler.js skillsByTrigger.
 $tools # re-emits the instructions.md — reminds LLM if forgotten mid-session

## BUILD
 pnpm 10.13.1
 start: node server.js

## ENTRY-POINTS
 server.js # main entry: node server.js / pnpm start
 start.bat # Windows launcher
 zerokey.bat # Windows launcher: auto-installs git/node/pnpm into .zerokey-tools\, clone/update/run
 zerokey.sh # Unix launcher: same flow via apt/dnf/yum/pacman/apk/brew, --prod installs

## MODULES
 server.js
  → express
  → routes/docs, routes/info, routes/health, routes/models, core/chat-router
  → core/session-selector
  → utils/find-port, utils/sync-ide-config, utils/logger, utils/errors, utils/sequential-queue
 chat-router.js
  → routes/claude, routes/chatgpt, routes/deepseek, routes/qwen
 session-selector.js
  → prompts (TUI)
  → providers/registry (registry.get(provider).createAPI/validateCredentials/setupSteps/models/reasoning)
 registry.js
  → providers/<name>/index.js (auto-discovered, each exports {name,models,reasoning,promptLimit,setupSteps,createAPI,validateCredentials,buildRouter})
 providers/<name>/router.js (e.g. deepseek/router.js)
  → engine/pipeline (StreamPipeline, passes messages → pipeline.session/rawMode)
  → providers/<name>/api, providers/<name>/stream-handler, providers/<name>/set-instructions (claude/qwen only)
  → utils/rate-limiter, utils/route-helpers
  qwen only: new session (non-raw): setQwenInstructions → pipeline.haveInstructionsAPI = true (skips buildPrompt inlining)
 pipeline.js
  → engine/compiler (ToolCompiler)
  → engine/syntax (MhiRegistry)
  → engine/triggers (restoreMcpInjections, showAvailableMcpTags, handleSkill)
  → utils/errors (classifyError)
  → utils/session-classifier (isRealChatSession), utils/ephemeral-session (ephemeralSession)
 compiler.js
  → engine/instructions, engine/tool-defs
  → engine/triggers (matchMcpTrigger)
  → utils/extract-files

## RUNTIME-GRAPH
 startup:
  server.js → findPort → SessionSelector.select (TUI wizard)
  → syncIdeConfig (writes VS Code chatLanguageModels.json)
  → buildRouter(selected) → registry.get(selected.provider).buildRouter(...) mounted at /v1/chat/completions
 per-request (POST /v1/chat/completions):
  sequentialQueue middleware serializes all requests through the mounted router (one in flight at a time, promise-chained)
  route handler → new StreamPipeline(res, session, provider, ide, messages)
  → pipeline ctor: isRealChatSession(ide, messages) classifies real chat turn vs ephemeral utility call (title-gen, tool-optimizer, etc.)
   → real: pipeline.session = session, pipeline.ephemeralMode = false, pipeline.rawMode = !pipeline.toolCalling
   → ephemeral: pipeline.session = ephemeralSession(session) (clone, chatSessionId/parentMessageId nulled, mutations discarded), pipeline.ephemeralMode = true, pipeline.rawMode = true
  → route uses pipeline.session (activeSession) for all chatSessionId/parentMessageId/stream-handler calls downstream
  → route sets pipeline.onFinalChunk (when pipeline.ephemeralMode) to delete the provider-side ephemeral chat session once the response finishes
  → pipeline.setup(messages, tools, req):
   → ephemeralMode: compiler.uploadAndFormatPromptForRaw(messages, pipeline, upload=false) — flat ROLE: content prompt, attachments decoded but not uploaded, skips skill-matching/MCP-tag scan
   → rawMode (non-ephemeral, !toolCalling): compiler.uploadAndFormatPromptForRaw(messages, pipeline, upload=true) — flat prompt, attachments uploaded via pipeline.upload
   → toolCalling: registerAutoMcpServers → restoreMcpInjections → showAvailableMcpTags (new session) → compiler.uploadAndFormatPrompt (uploads attachments, skill check) → buildPrompt
  → acquireSlot (rate limit)
  → providerApi.chatCompletion → stream
  → streamHandler → pipeline.scan (rawMode: emits text straight through, skips MHI tool-call parser; else MHI TOOL parsing, SSE chunk emission)
  → pipeline.sendFinalChunk → activeSession.lastUsed updated (ephemeral clone never persisted to user.sessions) → pipeline.onFinalChunk fires if set

## SCHEMA
 # Machine contract: openapi.json (OpenAPI 3.1) — served at GET /openapi.json, rendered at GET /docs
 # Regenerate spec: node scripts/gen-openapi.js
 # Root API.md: overview + shared infra (rate limiter, errors, SSE reader, compiler, pipeline) + users.json schema
 # Per-provider internal reference: providers/<name>/api.md (upstream endpoints, POW flow, HAR header order, SSE tables, session shapes)

 # OpenAI-compatible chat completions (subset)
 POST /v1/chat/completions
  body: {
    model: string,
    messages: [{ role: "system"|"user"|"assistant"|"tool", content: string|array }],
    tools?: [{ type: "function", function: { name, description, parameters } }],
    reasoning_effort?: string  # per-provider labels — providers/<name>/config.js reasoning.labels
  }
  content parts: { type: "image_url", image_url: { url: "data:mime;base64,..." } } | { type: "file", file: { file_data: "data:mime;base64,...", filename: "..." } }
  response: SSE stream of { id, object: "chat.completion.chunk", created, model, choices: [{ delta: {}, finish_reason }] }

 # Models
 GET /v1/models → { object: "list", data: Model[], activeModel }
 Model: { id, name, object: "model", created, owned_by, context_length, max_output_length }

 # Health
 GET /health → { status, uptime, timestamp, username, provider, model }

 # IDE detection
 Authorization: Bearer <vscode|terax|opencode> (default: vscode)

 # users.json (temp/users.json)
 {
   provider (deepseek|claude|chatgpt): {
     username: {
       username: string,
       parsedFetch: { headers: object, body: object, url: string },
       sessions: [{ name, chatSessionId, parentMessageId, createdAt, lastUsed, toolCalling, vision, model, dynamicToolsHash?, mcpInjected?: object }],
       waitUntil?: number (epoch ms),
       waitReason?: string
     }
   }
 }

## ENV
 PORT # default 7250
 DEEPSEEK_TRANSPORT # 'browser' (default) | 'api' — selects transport in providers/deepseek/router.js

## DEPENDENCIES
 express ^5.2.1
 node-fetch ^2.7.0
 prompts ^2.4.2
 dev: playwright ^1.63.0 (scripts/browser-flow.js — persistent-profile session capture reference)

## SCRIPTS
 scripts/browser-flow.js # DeepSeek web-UI driver — persistent-profile Chromium (temp/browser-profile), auto login via localStorage.userToken, drives composer (New chat → fill → Enter); passive response tap (page.on('response') on /api/v0/chat/completion) dumps raw SSE to temp/browser-flow-last.sse + summary to temp/browser-flow.log (never touches request)
 .vscode/mcp.json # MCP host config — registers @playwright/mcp (stdio, npx) with --user-data-dir=temp/browser-profile (same profile as scripts/browser-flow.js); profile is single-instance, so MCP and the script cannot run concurrently
 scripts/check-modules.js # Dependency integrity check

## CONFIG
 config/constants.js: CONFIG.PORT → env PORT or 7250 (only global config left here)
 providers/<name>/config.js (single source of truth per provider):
  models → { title, owned_by, models: { id: { id, name, vision, created, context_length, max_output_length, defaultReasoning? } } }
  reasoning → { labels, map } for reasoning_effort (see KNOWN-INVARIANTS)
  promptLimit → prompt/output char limit (claude/chatgpt 64k, deepseek/qwen 128k)
  setupSteps → { url, requestFilter, instructions } for SessionSelector TUI
 providers/registry.js: getModels() flattens all providers' models into { id: Model } (same shape as legacy MODELS)

## KNOWN-INVARIANTS
 registry.getModels() keyed by meta.id (slug), not display name; provider config.models: id = canonical slug, name = display label
 qwen/config.js models mirrors live chat.qwen.ai /api/v2/models list (6 models); vision flags taken from meta.capabilities.vision; max_output_length maps to meta.max_summary_generation_length (thinking length for qwen3.7-max which lacks summary)
 Qwen auth via cookie `token=<jwt>` (authorization Bearer optional); session auth validated by throwaway chat create+delete in QwenAPI.getCurrentUser()
 Qwen custom instructions written server-side via POST /api/v2/users/user/settings/update (personalization.instruction), hash-gated; routes/qwen.js sets haveInstructionsAPI=true on new sessions
Qwen reasoning: labels ['Auto','Think','Fast'] (providers/qwen/config.js); REASONING_MAP O(1) lookup maps to feature_config (thinking_enabled, auto_thinking, thinking_mode, thinking_format, auto_search); Fast mode omits thinking_format field; reasoningEffort passed from req.body.reasoning_effort; per-model restrictions: qwen3.7-max ['Think','Fast'] (no Auto), qwen3.5-omni-plus [] (no reasoning), all others ['Auto','Think','Fast']; unsupported reasoningEffort falls back to first allowed mode
Qwen selectMessage: POST /api/v2/chats/:chatId/messages/select called after each stream finishes (onFinished callback in stream-handler); marks selected response branch server-side; non-critical, failures silently ignored
Claude reasoning: provider-level labels ['Low'..'Max Think'] (8 tiers); Haiku override reasoning:['No Think','Think'] → thinking_mode:'extended'|'off', no effort tier; other models fall back to provider labels; per-model enforcement in router same pattern as Qwen
sync-ide-config.js reasoning: reads modelConfig.reasoning first (per-model), falls back to providerDef.reasoning.labels; supportsThinking = supportsReasoning (any provider with reasoning gets thinking:true in VS Code entry) model.defaultReasoning (providers/<name>/config.js, optional) seeds initial reasoningEffort per model in VS Code settings; triggers.js role 'instructions' renamed 'live_instructions' (compiler.js template + engine/instructions.md), passthrough injections (core/basic tools, MCP tag lists) now emit as <live_instructions> blocksNo API keys — all auth via browser session cookies captured from DevTools fetch()
 SessionSelector parses browser "Copy as fetch" string; TUI menu: saved users + Create + Delete (__delete__ → confirm → provider session cleanup → _removeUser); users.json atomic write via .tmp + rename
 ToolCompiler is a singleton per IDE×provider (cached in ToolCompiler.objects)
 Session state (chatSessionId, parentMessageId, lastUsed, todos) is mutated in-memory; persisted to users.json only on shutdown via selector.flush()
 CookieJar is shared per API client instance; cookies captured from response Set-Cookie headers
 DeepSeek uses a single unified model `default` (model_type: default) — thinking + search + vision; PoW challenge per request (WASM-based sha3); retries on SSE error exactly once
 reasoning labels are single source per provider (providers/<name>/config.js); sync-ide-config.js reads via registry.get(provider).reasoning.labels; each provider's api.js looks up its own reasoning.map O(1) and logs resolved value
  deepseek: {'Off':false,'DeepThink':true}; miss → false; labels ['Off','DeepThink']
  claude: label → {think,tier}; think→thinking_mode:'auto'+effort=tier else 'off'; labels ['Low','Low Think','Medium','Medium Think','High','High Think','Max','Max Think']
 Claude body: completion_request_id (UUID), effort+thinking_mode (not thinking_enabled); VS Code sync writes thinking:true, forwards only reasoning_effort
 Claude stream: thinking blocks → reasoning_content deltas (mirrors DeepSeek/Qwen), text_delta → parser.scan
 DeepSeek stream fragments typed THINK/RESPONSE; THINK → reasoning_content deltas, RESPONSE → parser.scan; currentFragmentType tracked from snapshot / fragments APPEND / content path events
 uploadAndFormatPrompt (messages, pipeline) → { prompt, skill }; uploadAndFormatPromptForRaw(messages, pipeline, upload) → { prompt }; both share uploadAndGetMessages
 buildPrompt (userPrompt, pipeline) inlines instructions on new session unless pipeline.haveInstructionsAPI
 skill check happens in pipeline.setup(), before provider call; triggering message never reaches provider
 session.mcpInjected populated by restoreMcpInjections from reqTools; once injected, tags stay for session lifetime
 pipeline.isNewSession, pipeline.toolCalling, pipeline.haveInstructionsAPI, pipeline.ephemeralMode set by StreamPipeline constructor; Claude sets haveInstructionsAPI=true
 Auto MCP registration: mcp_<server>_<tool> naming → $<server> tag, merged into MCP_ALIAS_MAPS
 SessionSelector is provider-agnostic: no provider-name string comparisons; delegates validateFetch/validateCredentials/waitPolicy/defaultVision to registry.get(provider); the two former claude/deepseek wait loops are one generic waitPolicy-gated loop
 StreamPipeline defers tool-call emission for terax/opencode (batched at flush), emits immediately for vscode; say block streams as plain text (md= prefix stripped once, closer not emitted) instead of going to toolBuffers
 Rate limiter: 15 req/60s window per provider label; provider 429 → setProviderCooldown(label, ms) blocks all requests for that label until cooldown expires (default: time left until next UTC hour boundary, since ChatGPT's limit is hourly; overridable via body cooldown_ms/retry_after_ms or retry-after header)
 ChatGPT 403 with "unusual activity" body text → device/IP flagged by Cloudflare (not a stale session); triggers 10 min setProviderCooldown('ChatGPT', ...), classified separately in errors.js (category device_flagged) from generic 401/403 session_expired
 server.js unhandled-error handler and all 4 stream handlers write via LogSaver (utils/log-saver.js, mkdir-p temp, size-rotation, optional beforeSave)
 Error log: temp/errors.log (1MB rotation); per-provider stream logs: temp/{deepseek,claude,chatgpt,qwen}-error.log (100KB rotation); stream entries carry reason, chatSessionId, parentMessageId, lastEventType, dataCount, producedOutput, finished, error:serializeError(e) — real thrown error's full field set, not a synthesized string
 Qwen additionally logs to temp/qwen-stream-debug.log (5MB rotation): stop-reason only (per-frame raw dump currently disabled in code)
 Qwen stream-handler accepts optional retry callback (providers/qwen/router.js supplies one): auto-retries once on RETRY_CODES inline error (quota_limit) or on a stream close with zero data frames; utils/errors.js classifies quota_limit as category provider_overloaded (status 503)
 DeepSeek createChatSession/chatCompletion await utils/human-delay.js humanDelay() before firing, to randomize request timing
 DeepSeek stream-close reason distinguishes partial vs no output (producedOutput flag); ChatGPT [DONE] onDone is normal, not an error path
 Provider-error frames logged with raw payload alongside serialized error (Claude case 'error', Qwen data.error, DeepSeek data.type==='error')
 VS Code model sync writes to %APPDATA%/Code/User/chatLanguageModels.json
 sequentialQueue (utils/sequential-queue.js) serializes every /v1/chat/completions request app-wide; no concurrent handling
 Ephemeral chat sessions are deleted provider-side via pipeline.onFinalChunk (set per-route when pipeline.ephemeralMode), fired from pipeline.sendFinalChunk

## EXTENSION-POINTS
 New IDE: add entry in IDES_PROMPT_OPTIMIZER (tool-defs.js), add IDE name to VALID_IDES (server.js)
 New provider: create providers/<name>/{index.js,api.js,router.js,stream-handler.js,config.js} (extend providers/base/* classes); index.js must export {name,displayName,models,reasoning,promptLimit,setupSteps,createAPI,validateCredentials,validateFetch,buildRouter}; optional: defaultVision (bool, vision fallback), waitPolicy ({label,userMessage,allMessage} — rate-limit/suspension TUI loop, presence signals waitUntil support); registry.js auto-discovers it, no other file needs editing
 Model config: mark recommendedForTools:true on models to badge them in the session TUI (replaces hardcoded slug list)
 New tool: add entry to TOOLS object (tool-defs.js), add per-IDE mapping
 New skill: add entry to triggers array (triggers.js), with trigger word + mhi template
 Stream pipeline: StreamPipeline owns the SSE lifecycle; ToolCompiler is a stateless service created by StreamPipeline
 MCP integration: tools with mcp_<server>_<tool> naming auto-register as $<server> skill tag
 Dynamic tools: passed via req.body.tools[], hashed per session for change detection
 Agent instructions: edit instructions.md (base) or skills-extra.md (grammar appends)