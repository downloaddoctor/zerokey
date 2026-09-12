# ChatGPT Provider — Internal Reference

> Public contract (models, reasoning labels, prompt limit): see [`openapi.json`](../../openapi.json) and `GET /docs`.

## Object: `ChatGPTAPI` (`providers/chatgpt/api.js`)

Manages HTTP requests to `chatgpt.com/backend-api` using browser-identical headers and sentinel proof-of-work tokens. Header order is endpoint-specific and must match browser HAR capture precisely.

## Internal API Endpoints Used

| Endpoint                                          | Method | Purpose                                      |
| ------------------------------------------------- | ------ | -------------------------------------------- |
| `/backend-api/sentinel/chat-requirements/prepare` | POST   | Refresh sentinel proof-of-work token         |
| `/backend-api/f/conversation/prepare`             | POST   | Prepare conversation, get conduit token      |
| `/backend-api/f/conversation`                     | POST   | Send chat completion (SSE stream)            |
| `/backend-api/conversation/{id}`                  | PATCH  | Soft-delete conversation (is_visible=false)  |
| `/backend-api/user_system_messages`               | PATCH  | Set custom instructions (currently disabled) |

## Dependencies

- **`ChatGPTProofOfWork`** (`providers/chatgpt/pow.js`): Sentinel POW solver — decodes proof token config, generates sentinel proof, solves POW challenges
- **`CookieJar`** (`utils/cookie-jar.js`): Cookie persistence across requests
- **`readSSE`** (`utils/sse-reader.js`): SSE stream parser
- **`setChatGPTInstructions`** (`providers/chatgpt/set-instructions.js`): PATCH user_system_messages (hash-cached; currently disabled in favor of prepending to prompt)
- **`Instructions`** (`engine/instructions.js`): System prompt singleton
- **`acquireSlot`** (`utils/rate-limiter.js`): 5 req / 15s sliding window rate limiter

## Flow

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

## ChatGPT SSE Event Format

| Event Type                | Shape                                                                                   | Action                          |
| ------------------------- | --------------------------------------------------------------------------------------- | ------------------------------- |
| input_message             | `{"type":"input_message","input_message":{"id":"..."}}`                                 | Capture parent msg ID           |
| message_stream_complete   | `{"type":"message_stream_complete","conversation_id":"..."}`                            | Capture conversation ID, finish |
| resume_conversation_token | `{"type":"resume_conversation_token","conversation_id":"..."}`                          | Capture conversation ID         |
| add (message)             | `{"o":"add","v":{"message":{"id":"..."}}}`                                              | Capture parent msg ID           |
| append (text delta)       | `{"p":"/message/content/parts/0","o":"append","v":"text"}`                              | Scan text delta                 |
| patch (finish)            | `{"o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"}]}` | Send final chunk                |
| bare text delta           | `{"v":"text"}`                                                                          | Scan text delta                 |

## Sentinel POW Flow

```
1. Decode existing openai-sentinel-proof-token → config array [version, seed, difficulty, ..., userAgent, ...]
2. Generate sentinel proof: ChatGPTProofOfWork.generateSentinelProof(config)
3. POST /backend-api/sentinel/chat-requirements/prepare with {p: sentinelProof}
4. Response: {prepare_token, proofofwork: {seed, difficulty}}
5. Solve POW: ChatGPTProofOfWork.solve(seed, difficulty, config) → new proof token
6. Store prepare_token, proof_token (+ "~S" suffix), turnstile token
7. These are sent as headers in subsequent /f/conversation requests
```

## Request Body Shape (sent to ChatGPT API)

```json
{
  "action": "next",
  "messages": [
    {
      "id": "<uuid>",
      "author": { "role": "user" },
      "content": { "content_type": "text", "parts": ["prompt text"] },
      "create_time": 1234567890.123,
      "metadata": {
        "selected_github_repos": [],
        "selected_all_github_repos": false,
        "serialization_metadata": { "custom_symbol_offsets": [] }
      }
    }
  ],
  "conversation_id": "<uuid>",
  "parent_message_id": "client-created-root",
  "client_prepare_state": "sent",
  "client_contextual_info": { "time_since_loaded": 12345 }
}
```

## Header Ordering (endpoint-specific HAR order)

**All endpoints:** `accept` → `accept-encoding` → `accept-language` → `authorization` → `cache-control` → `content-type` → `cookie` → `oai-client-build-number` → `oai-client-version` → `oai-device-id` → `oai-language` → `oai-session-id` → `origin` → `pragma` → `priority` → `referer` → `sec-ch-ua` → `sec-ch-ua-mobile` → `sec-ch-ua-platform` → `sec-fetch-dest` → `sec-fetch-mode` → `sec-fetch-site` → `user-agent` → `x-openai-target-path` → `x-openai-target-route`

**Conversation only (additional):** `oai-echo-logs` (after `oai-device-id`), `oai-telemetry` + sentinel tokens (after `oai-session-id`), `x-oai-turn-trace-id` (after `x-oai-is`)

**Prepare only (additional):** `x-conduit-token` (before `x-oai-is`)

**All authenticated:** `x-oai-is`

## Session Object Shape

```json
{
  "name": "2026-07-06 10:30",
  "disableTools": false,
  "model": "auto",
  "dynamicToolsHash": null,
  "chatSessionId": "abc-123-def",
  "parentMessageId": "client-created-root",
  "createdAt": "2026-07-06T10:30:00.000Z",
  "lastUsed": "2026-07-06T10:35:00.000Z",
  "todos": {}
}
```
