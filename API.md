# ZeroKey API Documentation

## Overview

ZeroKey is an OpenAI-compatible AI proxy server that routes chat completion requests to real browser sessions for **DeepSeek**, **Claude**, **ChatGPT**, and **Qwen** — without requiring API keys. It presents an OpenAI-compatible `/v1/chat/completions` endpoint that IDE plugins (VS Code, Terax, Opencode) can use as a drop-in replacement.

**Version:** 0.3.0
**Base URL:** `http://localhost:{PORT}` (default port: 7250, auto-increments if occupied)

---

## API Reference

The machine-readable contract is **[`openapi.json`](./openapi.json)** (OpenAPI 3.1). It covers every public endpoint with schemas, SSE examples, and error taxonomy.

- **Spec file:** `openapi.json` (repo root)
- **Interactive docs:** `GET /docs` (Swagger UI, served by the running server)
- **Raw spec:** `GET /openapi.json`
- **Regenerate the spec:** `node scripts/gen-openapi.js`

**Public endpoints:**

| Method | Path                   | Purpose                                           |
| ------ | ---------------------- | ------------------------------------------------- |
| GET    | `/`                    | API metadata + available models                   |
| GET    | `/health`              | Health check (uptime, active user/provider/model) |
| GET    | `/v1/models`           | List all models (OpenAI-compatible)               |
| GET    | `/v1/models/:model`    | Get a specific model by ID                        |
| POST   | `/v1/chat/completions` | Chat completions (SSE stream)                     |

For request/response shapes, error categories, and SSE chunk examples, see `openapi.json` or `/docs`.

---

## Providers

The server supports four AI providers. One is selected at startup via an interactive wizard, and the server routes all `/v1/chat/completions` requests through that provider.

**Per-provider internal reference** (upstream endpoints, POW flow, HAR header ordering, SSE event tables, session shapes):

- [DeepSeek](./providers/deepseek/api.md)
- [Claude](./providers/claude/api.md)
- [ChatGPT](./providers/chatgpt/api.md)
- [Qwen](./providers/qwen/api.md)

### Provider Selection Flow

```
server start
  → SessionSelector.select()
    → _stepProviderSelection()  → choose: deepseek | claude | chatgpt | qwen
    → _stepUserLogin()          → choose existing user or create new
    → _stepSessionSelection()   → choose existing session or create new
  → ChatRouter.mount(preSelected)
  → app.listen(port)
```

### Provider Overview

| Provider | Base URL                           | Auth Method                                      | Session Model                                         | Auto-Switch                  | Internal Ref                          |
| -------- | ---------------------------------- | ------------------------------------------------ | ----------------------------------------------------- | ---------------------------- | ------------------------------------- |
| DeepSeek | `https://chat.deepseek.com/api/v0` | Browser cookies + POW challenge                  | `chatSessionId` + `parentMessageId`                   | No                           | [api.md](./providers/deepseek/api.md) |
| Claude   | `https://claude.ai/api`            | Browser cookies + HAR headers                    | `chatSessionId` (UUID) + `parentMessageId` (UUID)     | Yes (rate-limit → next user) | [api.md](./providers/claude/api.md)   |
| ChatGPT  | `https://chatgpt.com/backend-api`  | Browser cookies + sentinel POW                   | `chatSessionId` (conversation_id) + `parentMessageId` | No                           | [api.md](./providers/chatgpt/api.md)  |
| Qwen     | `https://chat.qwen.ai/api/v2`      | Browser cookies (`token=` JWT) + optional Bearer | `chatSessionId` (chat id) + `parentMessageId`         | No                           | [api.md](./providers/qwen/api.md)     |

---

## Shared Infrastructure

### Rate Limiter (`utils/rate-limiter.js`)

**Algorithm:** Sliding window — 15 requests per 60 seconds per label (`DeepSeek`, `Claude`, `ChatGPT`, `Qwen`).

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
- 1MB buffer cap for malformed lines

### Stream Helpers (`utils/stream-helpers.js`)

**`createSendFinalChunk(res, session, parser, tokenUsage)`**

- Once-guard: calls `parser.flush()`, emits stop with usage, writes `[DONE]`, ends response
- Updates `session.lastUsed` in memory (no disk flush — done on shutdown via `selector.flush()`)

**`createOnError(res, parser, provider)`**

- Once-guard: classifies error, emits error chunk, ends response

### Cookie Jar (`utils/cookie-jar.js`)

Manages cookie persistence across requests:

- `seedFromHeader(cookieHeader)` → parses `Set-Cookie` / `Cookie` header
- `captureFromFetchHeaders(headers)` → extracts `set-cookie` from response
- `captureFromRawHeaders(rawHeaders)` → extracts from raw header array
- `toString()` → serializes all cookies for request header

### Tool Compiler (`engine/compiler.js`)

Singleton per IDE×provider (cached in `ToolCompiler.objects`):

- **`formatPrompt(messages, pipeline)`** → dispatches messages to role-specific handlers, handles file uploads via pipeline.upload, returns `{ prompt, skill }`
- **`buildPrompt(userPrompt, pipeline)`** → prepends system instructions on new sessions (unless pipeline.haveInstructionsAPI)
- **`compile(compactStr, session)`** → parses MHI compact string, emits IDE-specific tool call
- **`parse(compactStr)`** → 3-part parser: tool name, key=value pairs, repeating array groups
- **`emit(internal, session)`** → converts internal JSON to IDE-specific tool call format
- **`matchSkill(text, raw)`** → static — O(1) trigger-word lookup with positional param substitution

### Stream Pipeline (`engine/pipeline.js`)

Created per-request by routes — owns the SSE lifecycle:

- **`setup(messages, tools, req)`** → restoreMcpInjections → formatPrompt → skill check → buildPrompt → showAvailableMcpTags
- **`scan(text)`** → 3-state FSM (outside/toolStartFound/inTool) — parses MHI tool syntax, batches tool_calls on flush
- **`onError(error)`** → emits OpenAI-compatible error via stream
- **`emitAndEnd(text)`** → scan + flush + stop + DONE

### Instructions (`engine/instructions.js`)

Singleton that loads and caches system prompts:

- **`instructions.md`** — base system prompt with tool runtime format (SYNTAX/RULES/EXTRA)
- **`skills-extra.md`** — extra blocks (memory, save_workflow)
- SHA-256 hashed for cache invalidation

---

## User Data Schema (users.json)

```json
{
  "deepseek": {
    "username1": {
      "username": "username1",
      "parsedFetch": {
        "headers": { "cookie": "...", "user-agent": "..." },
        "body": {},
        "url": "https://chat.deepseek.com/..."
      },
      "sessions": [
        {
          "name": "2026-07-06 10:30",
          "chatSessionId": "abc123",
          "parentMessageId": "xyz789",
          "createdAt": "2026-07-06T10:30:00.000Z",
          "lastUsed": "2026-07-06T10:35:00.000Z",
          "todos": {}
        }
      ],
      "instructionsHash": null,
      "instructionsAppliedAt": null
    }
  },
  "claude": {
    "username1": {
      "username": "username1",
      "parsedFetch": {
        "headers": { "cookie": "...", "user-agent": "...", "sec-ch-ua": "..." },
        "body": {},
        "url": "https://claude.ai/api/organizations/..."
      },
      "sessions": [],
      "instructionsHash": "abc123...",
      "instructionsAppliedAt": "2026-07-06T10:30:00.000Z",
      "waitUntil": null,
      "waitReason": null
    }
  },
  "chatgpt": {
    "username1": {
      "username": "username1",
      "parsedFetch": {
        "headers": {
          "cookie": "...",
          "authorization": "...",
          "openai-sentinel-proof-token": "..."
        },
        "body": { "action": "next", "messages": [], "client_contextual_info": {} },
        "url": "https://chatgpt.com/backend-api/f/conversation"
      },
      "sessions": [],
      "instructionsHash": null,
      "instructionsAppliedAt": null,
      "model": null
    }
  }
}
```

**Claude-specific fields:**

- `waitUntil` — timestamp (ms epoch) when rate limit resets
- `waitReason` — e.g. `"rate_limit_error"`

**Session-specific fields:**

- `disableTools` — boolean; when true, tools + instructions not prepended
- `model` — provider-specific model string (e.g. "default", "claude-sonnet-4-6", "auto")
- `dynamicToolsHash` — SHA-256 hash of req.body.tools[] for MCP cache invalidation
- `todos` — persisted todo items from `todos_add`/`todos_set` tool calls

---

## IDE Support

The server detects the IDE from the `Authorization: Bearer <ide>` header. Supported values:

- `vscode` (default if absent or unknown)
- `terax`
- `opencode`

The IDE value is used by the Tool Compiler to select the correct IDE-specific tool mapping (`getIDEMapper(ide)` → `{tools, reverseMap, user, tool}`).

---

## Graceful Shutdown

On `SIGINT` / `SIGTERM`:

1. `selector.flush()` — persist current in-memory user state to users.json (atomic write via `.tmp` rename)
2. `server.close()` — stop accepting new connections
3. 5-second force-kill timeout

---

## Storage

All user data persists in users.json (atomic writes via `.tmp` rename). Sessions are updated in-memory during operation; `lastUsed` timestamp is set in-memory after each stream completes. Full disk flush happens only on:

- Graceful shutdown (`selector.flush()`)
- Claude rate-limit exit (flushes before process.exit(0))
- Initial session creation (eager write)
- Manual session deletion
- New user creation
