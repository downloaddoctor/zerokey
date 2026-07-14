# ZeroKey API Documentation

## Overview

ZeroKey is an OpenAI-compatible AI proxy server that routes chat completion requests to real browser sessions for **DeepSeek**, **Claude**, and **ChatGPT** — without requiring API keys. It presents an OpenAI-compatible `/v1/chat/completions` endpoint that IDE plugins (VS Code, Terax, Opencode) can use as a drop-in replacement.

**Version:** 1.0.0
**Base URL:** `http://localhost:{PORT}` (default port: 8000, auto-increments if occupied)

---

## Architecture

```
IDE Client (Bearer <ide-name>)
       │
       ▼
┌─────────────────────────────────────┐
│  Express Server (server.js)         │
│  ├─ IDE detection middleware        │
│  ├─ Request logger                  │
│  └─ ChatRouter                      │
│       ├─ POST /v1/chat/completions  │
│       │    ├─ DeepSeek route        │
│       │    ├─ Claude route          │
│       │    └─ ChatGPT route         │
│       ├─ GET /v1/models             │
│       ├─ GET /v1/models/:model      │
│       ├─ GET /                      │
│       └─ GET /health                │
└─────────────────────────────────────┘
```

---

## Endpoints

### 1. `GET /`

Root endpoint — returns API metadata and available models.

**Response `200 OK`:**
```json
{
  "name": "ZeroKey API Server",
  "version": "1.0.0",
  "description": "OpenAI-compatible AI proxy for DeepSeek, Claude & ChatGPT",
  "endpoints": {
    "models": "GET /v1/models",
    "chat_completions": "POST /v1/chat/completions",
    "health": "GET /health"
  },
  "models": ["DeepSeek V4", "GPT-4o", "Claude Sonnet 4.6", "Claude Sonnet 5", "Claude Haiku 4.5"]
}
```

---

### 2. `GET /health`

Health check endpoint — returns server uptime and status.

**Response `200 OK`:**
```json
{
  "status": "healthy",
  "uptime": 123.456,
  "timestamp": "2026-07-06T10:30:00.000Z"
}
```

---

### 3. `GET /v1/models`

Lists all available models in OpenAI-compatible format.

**Response `200 OK`:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "DeepSeek V4",
      "object": "model",
      "created": 1784736000,
      "owned_by": "deepseek",
      "context_length": 1000000,
      "max_output_length": 384000
    },
    {
      "id": "GPT-4o",
      "object": "model",
      "created": 1712822400,
      "owned_by": "openai",
      "context_length": 128000,
      "max_output_length": 16384
    },
    {
      "id": "Claude Sonnet 4.6",
      "object": "model",
      "created": 1772736000,
      "owned_by": "anthropic",
      "context_length": 1000000,
      "max_output_length": 64000
    }
  ]
}
```

---

### 4. `GET /v1/models/:model`

Get details for a specific model by ID.

**Path Parameters:**
| Name  | Type   | Required | Description                   |
| ----- | ------ | -------- | ----------------------------- |
| model | string | yes      | Model ID (e.g. `DeepSeek V4`) |

**Response `200 OK`:** Single model object (same shape as items in the list).

**Response `404 Not Found`:**
```json
{
  "error": {
    "message": "Model 'unknown-model' not found",
    "type": "invalid_request_error",
    "code": "model_not_found",
    "action": "Valid models: DeepSeek V4, GPT-4o, Claude Sonnet 4.6, Claude Sonnet 5, Claude Haiku 4.5",
    "category": "invalid_request",
    "status": 404
  }
}
```

---

### 5. `POST /v1/chat/completions`

**This is the primary endpoint.** OpenAI-compatible chat completion endpoint that routes to the currently selected provider.

**Headers:**
| Name          | Required | Description                                                       |
| ------------- | -------- | ----------------------------------------------------------------- |
| Authorization | no       | `Bearer <ide-name>` — valid values: `vscode`, `terax`, `opencode` |
| Content-Type  | yes      | `application/json`                                                |

**Request Body:**
| Field    | Type  | Required | Description                                                                                           |
| -------- | ----- | -------- | ----------------------------------------------------------------------------------------------------- |
| messages | array | yes      | Array of message objects `{role, content}`                                                            |
| tools    | array | no       | Array of tool definitions with `function.name` and `function.parameters` (OpenAI input_schema format) |

**Response:** `text/event-stream` (SSE) — OpenAI-compatible streaming chunks.

**SSE Chunk Types:**
- `data: {"choices":[{"delta":{"content":"text..."},"index":0}]}` — text delta
- `data: {"choices":[{"delta":{"tool_calls":[...]},"index":0}]}` — tool call batch (on stream close)
- `data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}], "usage":{...}}` — stop signal
- `data: [DONE]` — stream end

**Error Response (JSON, non-streaming):**
```json
{
  "error": {
    "message": "Human-readable error description",
    "type": "api_error",
    "code": "overloaded",
    "action": "Suggested recovery action",
    "category": "overloaded",
    "status": 529
  }
}
```

**Error Categories (from `utils/errors.js`):**
| Category         | Status | Description                                         |
| ---------------- | ------ | --------------------------------------------------- |
| overloaded       | 529    | Provider is overloaded, try again later             |
| session_expired  | 401    | Browser session expired, re-capture fetch()         |
| rate_limited     | 429    | Rate limit hit, wait or switch session              |
| cloudflare_block | 403    | Cloudflare challenge — browser fingerprint rejected |
| network          | 502    | Connection failed / timeout                         |
| invalid_request  | 502    | Provider returned unexpected/invalid response       |
| provider_error   | 502    | Upstream provider returned an HTTP error            |
| internal         | 500    | Unexpected server error                             |

---

## Providers

The server supports three AI providers. One is selected at startup via an interactive wizard, and the server routes all `/v1/chat/completions` requests through that provider.

### Provider Selection Flow

```
server start
  → SessionSelector.select()
    → _stepProviderSelection()  → choose: deepseek | claude | chatgpt
    → _stepUserLogin()          → choose existing user or create new
    → _stepSessionSelection()   → choose existing session or create new
  → ChatRouter.mount(preSelected)
  → app.listen(port)
```

### Provider Overview

| Provider | Base URL                           | Auth Method                     | Session Model                                         | Auto-Switch                  |
| -------- | ---------------------------------- | ------------------------------- | ----------------------------------------------------- | ---------------------------- |
| DeepSeek | `https://chat.deepseek.com/api/v0` | Browser cookies + POW challenge | `chatSessionId` + `parentMessageId`                   | No                           |
| Claude   | `https://claude.ai/api`            | Browser cookies + HAR headers   | `chatSessionId` (UUID) + `parentMessageId` (UUID)     | Yes (rate-limit → next user) |
| ChatGPT  | `https://chatgpt.com/backend-api`  | Browser cookies + sentinel POW  | `chatSessionId` (conversation_id) + `parentMessageId` | No                           |

---

## DeepSeek Provider

### Object: `DeepSeekAPI` (`core/deepseek/api.js`)

Manages HTTP requests to `chat.deepseek.com` using browser-identical headers and cookies. Requires a proof-of-work (POW) challenge to be solved before each chat completion.

### Internal API Endpoints Used

| Endpoint                            | Method | Purpose                                  |
| ----------------------------------- | ------ | ---------------------------------------- |
| `/api/v0/chat_session/create`       | POST   | Create a new chat session                |
| `/api/v0/chat/create_pow_challenge` | POST   | Get POW challenge for anti-bot           |
| `/api/v0/chat/completion`           | POST   | Send chat completion (SSE stream)        |
| `/api/v0/file/upload_file`          | POST   | Upload file (multipart, POW-protected)   |
| `/api/v0/file/fetch_files`          | GET    | Poll file processing status              |
| `/api/v0/chat_session/delete`       | POST   | Delete a single session server-side      |
| `/api/v0/chat_session/delete_all`   | POST   | Delete all sessions server-side          |

### Dependencies
- **`DeepSeekPOW`** (`core/deepseek/pow.js`): WASM-based proof-of-work solver
- **`CookieJar`** (`utils/cookie-jar.js`): Cookie persistence across requests
- **`readSSE`** (`utils/sse-reader.js`): SSE stream parser (1MB buffer cap, `[DONE]` detection)

### Flow

```
1. initialize(headers) → seed CookieJar, init POW solver
2. createChatSession() → POST /chat_session/create → returns chatSessionId
3. uploadFile(fileName, fileContent, fileSize):
   a. _getPowChallenge('/api/v0/file/upload_file') → POW challenge
   b. powSolver.solveChallenge(challenge) → x-ds-pow-response header
   c. Build multipart/form-data body with boundary
   d. POST /file/upload_file with x-ds-pow-response, x-file-size, x-model-type, x-thinking-enabled
   e. _pollFile(fileId) → GET /file/fetch_files every 1s up to 30 attempts → SUCCESS
4. chatCompletion(chatSessionId, prompt, parentMessageId, ..., refFileIds):
   a. _getPowChallenge() → POST /chat/create_pow_challenge
   b. powSolver.solveChallenge(challenge) → x-ds-pow-response header
   c. POST /chat/completion with ref_file_ids in body → SSE stream
5. Stream parsed via readSSE → streamHandler:
   a. "SET" with "FINISHED" → sendFinalChunk
   b. "BATCH" → capture token usage
   c. data.v.response → capture parentMessageId, scan content
   d. data.v (string) → scan text delta
   e. Error event → retry once (re-acquire rate slot, re-call chatCompletion)
   f. Stream closes without FINISHED → retry once
```

DeepSeek chat completions auto-extract files from leading messages before the last one.
Scans backwards from `messages[length-2]` down to index 0, stopping at the first message
without extractable file/image parts.

**Supported content part types:**
- `{ type: 'image_url', image_url: { url: 'data:<mime>;base64,...' } }`
- `{ type: 'file', file: { file_data: 'data:<mime>;base64,...', filename: '...' } }`

**Upload flow per file:**
1. POW challenge for `/api/v0/file/upload_file`
2. Solve challenge → `x-ds-pow-response` header
3. POST multipart/form-data with `x-file-size`, `x-model-type`, `x-thinking-enabled`
4. Poll `GET /api/v0/file/fetch_files?file_ids=<id>` until `status: "SUCCESS"` (max 30 attempts, 1s apart)
5. Collected `file_id`s passed as `ref_file_ids` in chat completion body


### DeepSeek SSE Event Format

| Event Type          | Shape                                                                      | Action                           |
| ------------------- | -------------------------------------------------------------------------- | -------------------------------- |
| SET/FINISHED        | `{"o":"SET","v":"FINISHED"}`                                               | Stream complete                  |
| BATCH (token usage) | `{"o":"BATCH","v":[{"p":"accumulated_token_usage","v":N}]}`                | Track token count                |
| Message response    | `{"v":{"response":{"message_id":"...","fragments":[{"content":"text"}]}}}` | Capture parent msg ID, scan text |
| Bare text delta     | `{"v":"text"}`                                                             | Scan text delta                  |
| Error               | `{"type":"error","content":"reason"}`                                      | Retry once, then send error      |

### Session Object Shape
```json
{
  "name": "2026-07-06 10:30",
  "chatSessionId": "abc123...",
  "parentMessageId": "xyz789...",
  "createdAt": "2026-07-06T10:30:00.000Z",
  "lastUsed": "2026-07-06T10:35:00.000Z",
  "disableTools": false,
  "model": "expert",
  "dynamicToolsHash": null,
  "_dynamicGrammarCache": null,
  "todos": {}
}
```

---

## Claude Provider

### Object: `ClaudeAPI` (`core/claude/api.js`)

Manages HTTP requests to `claude.ai/api` using browser-identical headers in **exact HAR order**. Cloudflare fingerprints header order — all requests must match real browser capture precisely.

### Internal API Endpoints Used

| Endpoint                                                          | Method | Purpose                           |
| ----------------------------------------------------------------- | ------ | --------------------------------- |
| `/api/organizations/{orgId}/chat_conversations/{uuid}/completion` | POST   | Send chat completion (SSE stream) |
| `/api/organizations/{orgId}/chat_conversations/{uuid}`            | DELETE | Delete a single conversation      |
| `/api/account_profile`                                          | PUT    | Set custom instructions (hash-cached) |

### Dependencies
- **`CookieJar`** (`utils/cookie-jar.js`): Cookie persistence
- **`readSSE`** (`utils/sse-reader.js`): SSE stream parser
- **`setClaudeInstructions`** (`core/claude/set-instructions.js`): PUT account_profile for custom instructions (hash-cached)
- **`acquireSlot`** (`utils/rate-limiter.js`): 5 req / 15s sliding window rate limiter

### Flow

```
1. initializeFromJSON(parsedFetch) → extract headers, orgId, seed CookieJar
2. chatCompletion(prompt, chatSessionId, parentMessageId, model, tools):
   a. Generate UUIDs for conversation + messages if new
   b. Build body with timezone, locale, model, personalized_styles
   c. For new conversations: include create_conversation_params
   d. POST /organizations/{orgId}/chat_conversations/{uuid}/completion → SSE stream
3. Stream parsed via readSSE → claudeStreamHandler:
   a. "message_start" → capture parentMessageId (message.uuid)
   b. "content_block_delta" with text_delta → scan text
   c. "message_limit" → check utilization (5h + 7d windows), if >= 90% delegates to route callback
   d. "message_stop" / "error" → sendFinalChunk or onError
4. On rate limit (>= 90%): route callback requests a conversation summary from Claude,
   emits an ask BPF with provider-switch options, sets waitUntil on userData,
   then calls process.exit(0). On hard exceeded errors, emits ask BPF in SSE and exits.
   Switching Claude users requires restarting the server.
```

### Claude SSE Event Format

| Event Type          | Shape                                                                                       | Action                                       |
| ------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| message_start       | `{"type":"message_start","message":{"uuid":"..."}}`                                         | Capture parent msg UUID                      |
| content_block_delta | `{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}`                 | Scan text delta    delegate to route callback if >= 90% |
| message_limit       | `{"type":"message_limit","message_limit":{"type":"...","windows":{"5h":{...},"7d":{...}}}}` | Check utilization, delegate to route callback if >= 90% |

| message_stop        | `{"type":"message_stop"}`                                                                   | Stream complete, sendFinalChunk              |
| error               | `{"type":"error","error":{"type":"overloaded_error","message":"..."}}`                      | Classify + send error                        |

### Request Body Shape (sent to Claude API)
```json
{
  "prompt": "user message text",
  "timezone": "America/Los_Angeles",
  "personalized_styles": [{ "type": "default", "key": "Default", "name": "Normal", "nameKey": "normal_style_name", "prompt": "Normal\n", "summary": "Default responses from Claude", "summaryKey": "normal_style_summary", "isDefault": true }],
  "locale": "en-US",
  "model": "claude-sonnet-4-6",
  "tools": [],
  "turn_message_uuids": { "human_message_uuid": "<uuid>", "assistant_message_uuid": "<uuid>" },
  "attachments": [],
  "files": [],
  "sync_sources": [],
  "rendering_mode": "messages",
  "parent_message_uuid": "<uuid>",
  "create_conversation_params": {
    "name": "",
    "model": "claude-sonnet-4-6",
    "include_conversation_preferences": true,
    "paprika_mode": null,
    "compass_mode": null,
    "is_temporary": false,
    "enabled_imagine": true
  }
}
```

### Header Ordering (exact HAR order for Cloudflare fingerprint)
1. `accept` → `accept-encoding` → `accept-language`
2. `anthropic-anonymous-id` → `anthropic-client-platform` → `anthropic-client-sha` → `anthropic-client-version` → `anthropic-device-id`
3. `content-type` → `cookie` → `origin` → `priority` → `referer`
4. `sec-ch-ua` → `sec-ch-ua-mobile` → `sec-ch-ua-platform`
5. `sec-fetch-dest` → `sec-fetch-mode` → `sec-fetch-site`
6. `user-agent` → `x-activity-session-id`

### Session Object Shape
```json
{
  "name": "2026-07-06 10:30",
  "chatSessionId": "550e8400-e29b-41d4-a716-446655440000",
  "parentMessageId": "550e8400-e29b-41d4-a716-446655440001",
  "createdAt": "2026-07-06T10:30:00.000Z",
  "lastUsed": "2026-07-06T10:35:00.000Z",
  "disableTools": false,
  "model": "claude-sonnet-4-6",
  "dynamicToolsHash": null,
  "_dynamicGrammarCache": null,
  "todos": {}
}
```

### Usage Limit Handling
When either the 5h or 7d usage window reaches >= 90% utilization, the stream handler
delegates to the route callback. The route requests a conversation summary from Claude,
emits an ask BPF with provider-switch options, sets `waitUntil` on userData, then calls
`process.exit(0)`. On hard exceeded errors (caught in the catch block), the route emits
an ask BPF directly in the SSE stream and exits. `userData.waitUntil` / `waitReason` are
consulted at startup in `SessionSelector.select()` — blocked users show "(limit reached)"
suffix and auto-switch to available users is offered.

## ChatGPT Provider

### Object: `ChatGPTAPI` (`core/chatgpt/api.js`)

Manages HTTP requests to `chatgpt.com/backend-api` using browser-identical headers and sentinel proof-of-work tokens. Header order is endpoint-specific and must match browser HAR capture precisely.

### Internal API Endpoints Used

| Endpoint                                          | Method | Purpose                                 |
| ------------------------------------------------- | ------ | --------------------------------------- |
| `/backend-api/sentinel/chat-requirements/prepare` | POST   | Refresh sentinel proof-of-work token    |
| `/backend-api/f/conversation/prepare`             | POST   | Prepare conversation, get conduit token |
| `/backend-api/f/conversation`                     | POST   | Send chat completion (SSE stream)       |
| `/backend-api/conversation/{id}`                 | PATCH  | Soft-delete conversation (is_visible=false) |
| `/backend-api/user_system_messages`              | PATCH  | Set custom instructions (currently disabled) |

### Dependencies
- **`ChatGPTProofOfWork`** (`core/chatgpt/pow.js`): Sentinel POW solver — decodes proof token config, generates sentinel proof, solves POW challenges
- **`CookieJar`** (`utils/cookie-jar.js`): Cookie persistence across requests
- **`readSSE`** (`utils/sse-reader.js`): SSE stream parser
- **`setChatGPTInstructions`** (`core/chatgpt/set-instructions.js`): PATCH user_system_messages (hash-cached; currently disabled in favor of prepending to prompt)
- **`Instructions`** (`lib/engine/instructions.js`): System prompt singleton
- **`acquireSlot`** (`utils/rate-limiter.js`): 5 req / 15s sliding window rate limiter

### Flow

```
1. initializeFromJSON(parsedFetch) → extract headers, body template
   a. Seed CookieJar from initial cookie header
   b. Decode existing sentinel proof token → extract config array
   c. Extract real User-Agent from config[4] (critical: browser omits UA in "Copy as fetch")
   d. _refreshSentinel() → POST sentinel/chat-requirements/prepare → get prepare_token + new proof token
2. chatCompletion(prompt, chatSessionId, parentMessageId):
   a. Generate message UUID
   b. _refreshSentinel() → fresh sentinel tokens
   c. _prepareConversation(chatSessionId, parentMessageId, partialQuery) → POST /f/conversation/prepare → conduit token
   d. Build body from template: action="next", set messages, conversation_id, parent_message_id
   e. POST /f/conversation → SSE stream
3. Stream parsed via readSSE → chatgptStreamHandler:
   a. "input_message" → capture parentMessageId
   b. "resume_conversation_token" → capture conversation_id as chatSessionId
   c. "add" with message.id → capture parentMessageId
   d. "/message/content/parts/0" + "append" → scan text delta
   e. "patch" with status "finished_successfully" → sendFinalChunk
   f. "message_stream_complete" → capture conversation_id, sendFinalChunk
```

### ChatGPT SSE Event Format

| Event Type                | Shape                                                                                   | Action                          |
| ------------------------- | --------------------------------------------------------------------------------------- | ------------------------------- |
| input_message             | `{"type":"input_message","input_message":{"id":"..."}}`                                 | Capture parent msg ID           |
| message_stream_complete   | `{"type":"message_stream_complete","conversation_id":"..."}`                            | Capture conversation ID, finish |
| resume_conversation_token | `{"type":"resume_conversation_token","conversation_id":"..."}`                          | Capture conversation ID         |
| add (message)             | `{"o":"add","v":{"message":{"id":"..."}}}`                                              | Capture parent msg ID           |
| append (text delta)       | `{"p":"/message/content/parts/0","o":"append","v":"text"}`                              | Scan text delta                 |
| patch (finish)            | `{"o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"}]}` | Send final chunk                |
| bare text delta           | `{"v":"text"}`                                                                          | Scan text delta                 |

### Sentinal POW Flow

```
1. Decode existing openai-sentinel-proof-token → config array [version, seed, difficulty, ..., userAgent, ...]
2. Generate sentinel proof: ChatGPTProofOfWork.generateSentinelProof(config)
3. POST /backend-api/sentinel/chat-requirements/prepare with {p: sentinelProof}
4. Response: {prepare_token, proofofwork: {seed, difficulty}}
5. Solve POW: ChatGPTProofOfWork.solve(seed, difficulty, config) → new proof token
6. Store prepare_token, proof_token (+ "~S" suffix), turnstile token
7. These are sent as headers in subsequent /f/conversation requests
```

### Request Body Shape (sent to ChatGPT API)
```json
{
  "action": "next",
  "messages": [{
    "id": "<uuid>",
    "author": { "role": "user" },
    "content": { "content_type": "text", "parts": ["prompt text"] },
    "create_time": 1234567890.123,
    "metadata": {
      "selected_github_repos": [],
      "selected_all_github_repos": false,
      "serialization_metadata": { "custom_symbol_offsets": [] }
    }
  }],
  "conversation_id": "<uuid>",
  "parent_message_id": "client-created-root",
  "client_prepare_state": "sent",
  "client_contextual_info": { "time_since_loaded": 12345 }
}
```

### Header Ordering (endpoint-specific HAR order)
**All endpoints:** `accept` → `accept-encoding` → `accept-language` → `authorization` → `cache-control` → `content-type` → `cookie` → `oai-client-build-number` → `oai-client-version` → `oai-device-id` → `oai-language` → `oai-session-id` → `origin` → `pragma` → `priority` → `referer` → `sec-ch-ua` → `sec-ch-ua-mobile` → `sec-ch-ua-platform` → `sec-fetch-dest` → `sec-fetch-mode` → `sec-fetch-site` → `user-agent` → `x-openai-target-path` → `x-openai-target-route`

**Conversation only (additional):** `oai-echo-logs` (after `oai-device-id`), `oai-telemetry` + sentinel tokens (after `oai-session-id`), `x-oai-turn-trace-id` (after `x-oai-is`)

**Prepare only (additional):** `x-conduit-token` (before `x-oai-is`)

**All authenticated:** `x-oai-is`

### Session Object Shape
```json
{
  "name": "2026-07-06 10:30",
  "disableTools": false,
  "model": "auto",
  "dynamicToolsHash": null,
  "_dynamicGrammarCache": null,
  "chatSessionId": "abc-123-def",
  "parentMessageId": "client-created-root",
  "createdAt": "2026-07-06T10:30:00.000Z",
  "lastUsed": "2026-07-06T10:35:00.000Z",
  "todos": {}
}
```

---

## Shared Infrastructure

### Rate Limiter (`utils/rate-limiter.js`)

**Algorithm:** Sliding window — 5 requests per 15 seconds per label (`DeepSeek`, `Claude`, `ChatGPT`).

**Function:** `acquireSlot(label, reset)`
- If window expired or in future → reset count
- If under limit → increment count, resolve immediately
- If at limit → calculate wait time, return Promise that resolves after timeout

### Error Classification (`utils/errors.js`)

**Function:** `classifyError(error, provider)` → returns classification object with `{category, message, action, status}`

9 categories mapped from error message patterns and HTTP status codes (see error table in Endpoint 5 above).

**Function:** `toOpenAIError(error, provider, type, code)` → returns OpenAI-compatible `{error: {message, type, code, action, category, status}}`
Two calling conventions: `toOpenAIError(errorObject, providerName)` classifies via `classifyError`; `toOpenAIError(statusCode, message, type, code)` builds the response directly (used by route handlers for validation errors).

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

### Tool Compiler (`lib/engine/index.js`)

Per-request singleton keyed by `ide:provider`:
- **`formatPrompt(messages, isNewSession)`** → dispatches last message to role-specific handler
- **`buildPrompt(userPrompt, dynamicGrammar)`** → prepends system instructions + dynamic grammar
- **`syncDynamicTools(reqTools, session)`** → hashes tool array, filters inbuilts, registers passthrough entries, caches grammar
- **`compile(toolCall)`** → parses generic tool args, emits IDE-specific tool call
- **`Stream`** → 3-state FSM (outside/toolStartFound/inTool) — parses `⟦tool_name(¦param=value)+` syntax, batches tool_calls on stream close

### Instructions (`lib/engine/instructions.js`)

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
      "sessions": [...],
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
        "headers": { "cookie": "...", "authorization": "...", "openai-sentinel-proof-token": "..." },
        "body": { "action": "next", "messages": [...], "client_contextual_info": {...} },
        "url": "https://chatgpt.com/backend-api/f/conversation"
      },
      "sessions": [...],
      "instructionsHash": null,
      "instructionsAppliedAt": null,
      "model": null
  }
}
```

**Claude-specific fields:**
- `waitUntil` — timestamp (ms epoch) when rate limit resets
- `waitReason` — e.g. `"rate_limit_error"`

**Session-specific fields:**
- `disableTools` — boolean; when true, tools + instructions not prepended
- `model` — provider-specific model string (e.g. "expert", "claude-sonnet-4-6", "auto")
- `dynamicToolsHash` — SHA-256 hash of req.body.tools[] for MCP cache invalidation
- `_dynamicGrammarCache` — cached BPF grammar string for current tool set
- `todos` — persisted todo items from `todos_add`/`todos_set` tool calls

---

## Configuration (constants.js)

| Constant | Default | Description               |
| -------- | ------- | ------------------------- |
| PORT     | 8000    | Server port (env: `PORT`) |

**Models:**
| ID                | Owned By  | Context Length | Max Output |
| ----------------- | --------- | -------------- | ---------- |
| DeepSeek V4       | deepseek  | 1,000,000      | 384,000    |
| GPT-4o            | openai    | 128,000        | 16,384     |
| Claude Sonnet 4.6 | anthropic | 1,000,000      | 128,000    |
| Claude Sonnet 5   | anthropic | 1,000,000      | 128,000    |
| Claude Haiku 4.5  | anthropic | 200,000        | 64,000     |

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
