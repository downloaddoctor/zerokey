ENTRY → server.js: express app + interactive startup wizard
 server.js: cors + json(50mb) + ide middleware (Authorization Bearer → req.ide, default vscode)
 server.js: mount /v1/models → modelsRouter, mount / → healthRouter
 server.js: SessionSelector wizard → provider/user/session → buildChatRouter|buildChatGPTRouter|buildClaudeRouter
 server.js: port check loop (fetch localhost, increment +100) → app.listen

FLOW → Request → Middleware → Route → Core API → Stream → Response
 POST /v1/chat/completions → ide extraction middleware → chatRouter (deepseek|chatgpt|claude) → ToolCompiler.formatPrompt → API call → stream handler + Stream parser → SSE chunks → [DONE]
 GET /v1/models → models list | /v1/models/:model → model detail via MODEL_ALIASES
 GET /health → { status, uptime, timestamp }
 GET / → API info + endpoints + models

ROUTES → decision dispatch
 /v1/chat/completions: deepseek → buildChatRouter(headers, session, saveSession) → Express router POST
 /v1/chat/completions: chatgpt → buildChatGPTRouter(parsedFetch, session, saveSession) → Express router POST
 /v1/chat/completions: claude → buildClaudeRouter(parsedFetch, session, saveSession) → Express router POST
 /v1/models: models.js → GET / lists MODELS, GET /:model resolves MODEL_ALIASES
 /: health.js → GET /health (health check), GET / (API info)
 ide routing: req.ide extracted per-request → ToolCompiler(ide) → IDE-specific tool defs + prompt optimizer

CORE → behavior nodes
 config/constants.js: CONFIG (PORT), MODELS (deepseek/chatgpt/claude with capabilities), MODEL_ALIASES
 core/session-selector.js: SessionSelector — inquirer wizard (provider→user→session), parseFetchDirect (brace-balancing fetch() parser), users.json atomic write (tmp+rename)
 core/deepseek/api.js: DeepSeekAPI — POW challenge→solve→chat/completion, keep-alive HTTPS agent, CookieJar integration, chat_session/create
 core/chatgpt/api.js: ChatGPTAPI — sentinel refresh (proof token decode→solve→prepare), conversation/prepare (conduit token), ordered HAR-matching header builder with endpoint-specific blocks, CookieJar
 core/claude/api.js: ClaudeAPI — initializeFromJSON (HAR capture), chatCompletion (Web Streams), ordered HAR-matching header builder (Cloudflare fingerprint), CookieJar, org ID extraction, UUID generation
 core/deepseek/pow.js: DeepSeekPOW — WASM SHA3-512 solver (sha3_wasm_bg.7b9ca65ddd.wasm), offloaded via setImmediate, base64-encoded result
 core/chatgpt/pow.js: ChatGPTProofOfWork — pure JS SHA3-512, gAAAAAB-encoded config arrays, sentinel proof generation, difficulty threshold matching
 utils/cookie-jar.js: CookieJar — shared Map-based storage, parseSetCookie, seedFromHeader, captureFromFetchHeaders, captureFromRawHeaders, toString serialization
 utils/errors.js: toOpenAIError — { status, message, type, code } error factory

TRANSFORMS → parsing, streaming, tool execution
 stream.js: Stream class — multi-tool buffering (toolBuffers[]), recursive scan('') for single-chunk detection, ⟦tool¦payload⟧ marker parsing without regex, 3-state machine (idle→toolStartFound→inTool), flush() batch-emits all tools as buildToolDelta
 core/deepseek/stream-handler.js: streamHandler — Node.js stream on data/end/error, BATCH/SET/FINISHED dispatch, parser.scan for fragments, tokenUsage tracking, sendFinalChunk with usage
 core/chatgpt/stream-handler.js: chatgptStreamHandler — Web Streams reader, SSE line parsing, dispatch by type/o fields, parser.scan for content
 core/claude/stream-handler.js: claudeStreamHandler — Web Streams reader, SSE line parsing, dispatch by data.type (message_start→parentMessageId, content_block_delta→parser.scan, message_stop→sendFinalChunk)
 lib/engine/index.js: ToolCompiler — singleton per IDE, formatPrompt (role-based handler dispatch), buildPrompt (base prompt + IDE prompt + user), compile (parse→emit pipeline), inferType for param values
 lib/engine/tool-defs.js: getIDEMapper — generates prompt grammar + resolved tools map + reverseMap per IDE, IDES_PROMPT_OPTIMIZER (vscode/terax user/tool formatters), RAW_EDIT transform helpers (resolveAnchors, applyTransform)
 lib/engine/stream.js: SSE chunk emitter (chunkPrefix+delta+chunkMid+finishReason+chunkUsage+chunkSuffix), buildCall per tool, buildToolDelta for batch
 lib/engine/prompt.md: system prompt — BOOT MODEL schema, tool format grammar, CODE STYLE, SAVE rules
 lib/engine/extra-tools.js: EXTRA_TOOLS — VSCode-only tools (create_jupyter, fetch_web, browser_*, subagent, memory, etc.)
 lib/engine/templates/: IDE-specific tool templates (terax.json, vscode.json)
 POW (DeepSeek): WASM SHA3-512 → setImmediate offload → answer + base64 encode
 POW (ChatGPT): pure JS SHA3-512 → config array → difficulty threshold → gAAAAAB encode
 fetch() parse: SessionSelector._parseFetchDirect — brace-depth counter, string-literal aware, extracts headers+body JSON

FAILURES → retry, fallback, recovery
 server.js: port busy → increment up to +100, find first free; no ports → exit(1)
 server.js: no session selected → exit(0); startup error → exit(1)
 deepseek/api.js: non-200 → collect error body, reject {errorBody, code}; timeout → req.destroy; JSON parse fail → reject
 chatgpt/api.js: sentinel refresh fail → throw with response text; missing proof token → throw "incomplete data"
 chatgpt/api.js: prepareConversation non-200 → log+continue (non-fatal); no conduit_token → return without update
 claude/api.js: non-200 → collect error text, throw Claude HTTP {status}; missing orgId → throw; initializeFromJSON no cookies → warn (non-fatal)
 stream-handler (deepseek): error event → JSON error to response; writableEnded check → skip redundant writes
 stream-handler (chatgpt): catch block → emit error via parser, write error JSON, end; DONE in buffer → sendFinalChunk early
 stream-handler (claude): catch block → emit error, write error JSON, end; finished guard → skip redundant writes
 stream.js: tool buffer overflow (>64KB) → warn, discard, reset inTool; unknown tool marker → flush as plain text; incomplete tool at flush → salvage to toolBuffers
 session-selector.js: file read errors → return {}; file write errors → log only; prompt cancellation (Ctrl+C) → return null
 cookie-jar.js: parse failures → return null, skip silently
 POW: 100k iterations unsolved → throw "unsolvable"; minimal config → throw; invalid token prefix → throw
 routes: missing messages → 400; missing model → 404; internal errors → 500 (all via toOpenAIError)
 initDeepSeekAPI: no session → throw; existing chatSessionId → skip creation
 ChatGPTAPI: non-200 on chatCompletion → log status, throw with response text slice
