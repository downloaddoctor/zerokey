# ZeroKey API Documentation

## Overview

ZeroKey is an OpenAI-compatible AI proxy server that routes chat completion requests to real browser sessions for **DeepSeek**, **Claude**, **ChatGPT**, **Qwen**, and **Inception (Mercury)** — without requiring API keys. It presents an OpenAI-compatible `/v1/chat/completions` endpoint that IDE plugins (VS Code, Terax, Opencode) can use as a drop-in replacement.

**Version:** 0.5.0
**Base URL:** `http://127.0.0.1:{PORT}` — loopback only (DNS-rebinding guard). Default port 7250; each instance claims the first free port in `[PORT, PORT+PORT_RANGE)`, or refuses with `ZEROKEY_EXACT_PORT=1`. Multiple instances share `temp/db/zerokey.db`, one port each.

---

## API Reference

The machine-readable contract is **[`openapi.json`](./openapi.json)** (OpenAPI 3.1). It covers every public endpoint with schemas, SSE examples, and error taxonomy.

- **Spec file:** `openapi.json` (repo root)
- **Interactive docs:** `GET /docs` (Swagger UI, served by the running server)
- **Raw spec:** `GET /openapi.json`
- **Maintenance:** hand-maintained — edit `openapi.json` directly (there is no generator script)

**Public endpoints:**

| Method | Path                   | Purpose                                                         |
| ------ | ---------------------- | --------------------------------------------------------------- |
| GET    | `/`                    | API metadata + available models                                 |
| GET    | `/health`              | Health + persistence snapshot (uptime, session, schema_version) |
| GET    | `/v1/models`           | List all models (OpenAI-compatible)                             |
| GET    | `/v1/models/:model`    | Get a specific model by ID                                      |
| POST   | `/v1/chat/completions` | Chat completions (SSE stream)                                   |

### Plain OpenAI clients (no IDE)

When the request has no recognizable IDE system prompt and is not a known IDE
utility call, ZeroKey routes to the built-in `openai` surface:

- Generic tool names pass through unchanged (identity mapping).
- The internal MHI grammar is inlined into the system prompt.
- Whether a tool loop runs is decided by the session's `toolCalling` flag (set
  in the wizard), not by whether `tools[]` is present in the request body.
- The tool loop runs the same executors used by IDE surfaces (`read`, `write`,
  `replace`, `ls`, `glob`, `grep`, `cmd`, `cmd_bg`, `cmd_poll`, `cmd_kill`,
  `errors`, `fetch`, `view_image`, `todos_add`, `todos_set`, `ask`).

Known IDE-internal utility calls (title generation, progress messages,
summarizer, terminal quick fix, …) are declared per surface and are always
ephemeral — they never write into the session.

For request/response shapes, error categories, and SSE chunk examples, see `openapi.json` or `/docs`.

---

## Providers

The server supports five AI providers. One is selected at startup via an interactive wizard, and the server routes all `/v1/chat/completions` requests through that provider.

**Per-provider internal reference** (upstream endpoints, POW flow, HAR header ordering, SSE event tables, session shapes):

- [DeepSeek](./providers/deepseek/api.md)
- [Claude](./providers/claude/api.md)
- [ChatGPT](./providers/chatgpt/api.md)
- [Qwen](./providers/qwen/api.md)

There is no `providers/inception/api.md` — Inception is authless and browser-driven; see `providers/inception/`.

### Provider Selection Flow

```
server start
  → SessionSelector.select()
    → _stepProviderSelection()  → choose: deepseek | claude | chatgpt | qwen | inception
    → _stepUserLogin()          → choose existing user or create new
    → _stepSessionSelection()   → choose existing session or create new
  → buildRouter(preSelected, {db, userId, sessionName})
  → app.listen(port)
```

### Provider Overview

| Provider  | Base URL                           | Auth Method                                        | Session Model                                                                                          | Wait policy            | Internal Ref                          |
| --------- | ---------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------- |
| DeepSeek  | `https://chat.deepseek.com/api/v0` | Browser cookies + POW challenge                    | `chatSessionId` + `parentMessageId`                                                                    | suspended (wait_until) | [api.md](./providers/deepseek/api.md) |
| Claude    | `https://claude.ai/api`            | Browser cookies + HAR headers                      | `chatSessionId` (UUID) + `parentMessageId` (UUID)                                                      | at-limit → next user   | [api.md](./providers/claude/api.md)   |
| ChatGPT   | `https://chatgpt.com/backend-api`  | Browser cookies + sentinel POW                     | `chatSessionId` (conversation_id) + `parentMessageId`                                                  | No                     | [api.md](./providers/chatgpt/api.md)  |
| Qwen      | `https://chat.qwen.ai/api/v2`      | Browser cookies (`token=` JWT) + optional Bearer   | `chatSessionId` (chat id) + `parentMessageId`                                                          | daily-limit            | [api.md](./providers/qwen/api.md)     |
| Inception | `https://chat.inceptionlabs.ai`    | None (authless); real Chromium profile, no capture | browser UI keeps the thread; `session.metadata.promptCount` drives summary rotation at the 47th prompt | none                   | see `providers/inception/`            |

---

## Shared Infrastructure

### Rate Limiter (`utils/rate-limiter.js`)

**Algorithm:** Sliding window — 15 requests per 60 s per label (`DeepSeek`, `Claude`, `ChatGPT`, `Qwen`, `Inception`). A provider 429 sets a cooldown that overrides the normal window (`setProviderCooldown`).

**Function:** `acquireSlot(label, reset)`

- If window expired or in future → reset count
- If under limit → increment count, resolve immediately
- If at limit → calculate wait time, return Promise that resolves after timeout

### Error Classification (`utils/errors.js`)

**Function:** `classifyError(error, provider)` → returns classification object with `{category, message, action, status}`.

**Function:** `toOpenAIError(error, provider, type, code)` → returns OpenAI-compatible `{error: {message, type, code, action, category, status}}`.
Two calling conventions: `toOpenAIError(errorObject, providerName)` classifies via `classifyError`; `toOpenAIError(statusCode, message, type, code)` builds the response directly (used by route handlers for validation errors).

See `openapi.json` `components.schemas.ErrorCategory` for the full category enum.

### SSE Reader (`utils/sse-reader.js`)

**Function:** `readSSE(stream, {onData, onDone, onError})`

- Reads Web ReadableStream via `getReader()` + `TextDecoder`
- Splits on `\n`, handles partial lines
- Parses `data:` lines as JSON
- Detects `[DONE]` → calls `onDone`
- 1 MiB line cap for malformed lines (see `utils/sse-reader.js`)

### SSE Writer (`utils/sse-writer.js`)

**`createWriter(res, {id, model})`** — backpressure-aware SSE frame writer (awaits `drain` when the socket is full)

- Methods: `reasoning`, `text`, `toolCalls`, `finish(reason, usage)`, `fail(message, code)`
- Every frame runs through one promise chain, so wire order equals call order
- `finish` and `fail` are idempotent; both end the stream with `[DONE]`

**`joinMessages(soFar, next)`** — pure helper; pads the gap between two assistant messages to exactly two newlines

The per-request stream lifecycle (scan, flush, stop, error emission) lives in `engine/pipeline.js`.

### Cookie Jar (`utils/cookie-jar.js`)

Manages cookie persistence across requests:

- `seedFromHeader(cookieHeader)` → parses `Set-Cookie` / `Cookie` header
- `captureFromFetchHeaders(headers, label)` → extracts `set-cookie` from a fetch response
- `captureFromRawHeaders(rawHeaders, label)` → same, from a raw header array
- `toString()` → serializes all cookies for the request header

### Tool Compiler (`engine/compiler.js`)

Singleton per IDE×provider (cached in `ToolCompiler.objects`):

- **`uploadAndFormatPrompt(messages, pipeline)`** → slices after the last assistant, decodes data-URI uploads, dispatches role handlers, returns `{ prompt, skill }`
- **`buildPrompt(userPrompt, pipeline)`** → prepends system instructions on a new session (unless the provider has an instructions API)
- **`compile(compactStr, session)`** → parses MHI compact string, emits IDE-specific tool call
- **`parse(compactStr)`** → 3-part parser: tool name, key=value pairs, repeating array groups
- **`emit(internal, session)`** → converts internal JSON to IDE-specific tool call format
- **`matchSkill(text, raw)`** → O(1) trigger map, plus `matchMcpTrigger` and positional `#{name}#` params`

### Stream Pipeline (`engine/pipeline.js`)

Created per-request by routes — owns the SSE lifecycle:

- **`setup(messages, tools, req)`** → registerAutoMcpServers → restoreMcpInjections → reinjectEvery / reinjectAt → drift + loop-break fragments → uploadAndFormatPrompt → skill → buildPrompt
- **`scan(text)`** → 3-state FSM (outside/toolStartFound/inTool) — parses MHI tool syntax, batches tool_calls on flush
- **`flush()`** → inspectBatch → cross-turn loop-break → emitToolCalls
- **`flushFinish()`** → usage fold + turnCount → one `[DONE]`
- **`onError(error)`** → emits OpenAI-compatible error via stream
- **`emitAndEnd(text)`** → scan + flush + stop + DONE

The single `[DONE]` is deferred until the tool loop resolves (deferFinish). Intermediate assistant text is invisible to the client.

### Instructions (`engine/instructions.js`)

Singleton that loads and caches prompt fragments through `utils/bundle.js` (disk from source, embedded in the dist bundle):

- **`instructions.md`** — full agent system prompt incl. `<mhi_list>`
- **`agent.md`** — the `<memory>` workflow (AGENTS.md read/update)
- **`extra/*.md`** — extra fragments; each auto-registers as `$<basename>` (`loop-break`, `reminder`, `summary`, `test`, `instructions-1500`)
- SHA-256 hashed for cache invalidation (`getExtra` caches per file; `list()` exposes hashes)

---

## User Data Schema (SQLite)

Users and sessions persist in `temp/db/zerokey.db` (SQLite via `sqlite-pro`). Column names are snake_case; JS objects are camelCase (mapped in `core/state/users.js` and `core/state/sessions.js`). The authoritative schema is declared in JS next to each store (`SCHEMA` in `core/state/users.js` and `core/state/sessions.js`); `sqlite-pro` generates the DDL. `BASE_SCHEMA_VERSION=4` — `db.open` refuses a DB whose `meta.schema_version` exceeds it (fail-closed).

| Table          | Key                          | Holds                                                                                                                                                                                                      |
| -------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`        | `UNIQUE(provider, username)` | `capture_url`, `capture_method`, `capture_body`, `capture_body_base64`, `capture_extra`, `instructions_hash`, `instructions_applied_at`, `wait_until`, `wait_reason`                                       |
| `sessions`     | `PK(user_id, name)`          | `id`, `parent_id`, `generation`, `tool_calling`, `vision`, `model`, `todos_json`, `turn_count`, `dynamic_tools_hash`, `mcp_injected_json`, `metadata_json`, `usage_totals_json`, `last_used`, `created_at` |
| `user_headers` | `PK(user_id, name)`          | one row per captured request header (`value`, `pos`); cascades on user delete                                                                                                                              |
| `meta`         | `key`                        | `schema_version`                                                                                                                                                                                           |

**Claude-specific user fields:**

- `wait_until` — timestamp (ms epoch) when the rate limit resets
- `wait_reason` — e.g. `"rate_limit_error"`

**Session-specific fields:**

- `tool_calling` — boolean; when false, tools + instructions are not prepended
- `model` — provider-specific model string (e.g. "default", "claude-sonnet-4-6", "auto")
- `dynamic_tools_hash` — SHA-256 hash of req.body.tools[] for MCP cache invalidation
- `todos_json` — persisted todo items from `todos_add`/`todos_set` tool calls
- `metadata_json` — provider extras (Inception keeps `promptCount` here for summary rotation)

---

## IDE Support

The tool surface is resolved per request from the system prompt fingerprint (`surfaces/registry.js` `resolveSurface` → `getIDEMapper(surface)` → `{tools, reverseMap, user, system, tool}`). Surfaces are auto-discovered from `surfaces/<name>/index.js`: `vscode`, `copilot`, `terax`, `opencode`, `openai`. The `openai` surface declares `realSessionPrefix = null`, so it is never matched by fingerprint — it is the fallback.

Priority (see `utils/session-classifier.js`):

1. Real IDE fingerprint (`resolveSurface`) → isReal: true, surface: matched
2. IDE-internal utility (`resolveUtility`) → isReal: false (ephemeral), surface: openai
3. Otherwise → `openai` surface, isReal: true

The `openai` surface is the default for plain OpenAI SDK callers, new IDEs before a fingerprint is declared, and curl scripts. Whether a tool loop runs is decided by the session's `toolCalling` flag, not by `tools[]` presence.

---

## Graceful Shutdown

On `SIGINT` / `SIGTERM` / `SIGHUP` (`server.js`):

1. `selector.flush()` — drain pending debounced writes
2. `app.stop()` — stop accepting new connections
3. `cleanup()` — flush + close the store, then `startup.release(port)`
4. `uncaughtException` logs the full stack, drains, and exits 1; `unhandledRejection` logs only

---

## Storage

All user and session data persists in SQLite (`temp/db/zerokey.db`). Rows are Proxy objects: top-level and nested writes (`parsedFetch.*`, `metadata.*`, `todos`) schedule a 250 ms debounced write-through. `sessions.flushNow` runs when a response finishes or closes, and `flushAll()` drains everything at shutdown.
