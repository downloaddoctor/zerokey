# DeepSeek Provider — Internal Reference

> Public contract (models, reasoning labels, prompt limit): see [`openapi.json`](../../openapi.json) and `GET /docs`.

## Object: `DeepSeekAPI` (`providers/deepseek/api.js`)

Manages HTTP requests to `chat.deepseek.com` using browser-identical headers and cookies. Requires a proof-of-work (POW) challenge to be solved before each chat completion.

## Internal API Endpoints Used

| Endpoint                            | Method | Purpose                                |
| ----------------------------------- | ------ | -------------------------------------- |
| `/api/v0/chat_session/create`       | POST   | Create a new chat session              |
| `/api/v0/chat/create_pow_challenge` | POST   | Get POW challenge for anti-bot         |
| `/api/v0/chat/completion`           | POST   | Send chat completion (SSE stream)      |
| `/api/v0/file/upload_file`          | POST   | Upload file (multipart, POW-protected) |
| `/api/v0/file/fetch_files`          | GET    | Poll file processing status            |
| `/api/v0/chat_session/delete`       | POST   | Delete a single session server-side    |
| `/api/v0/chat_session/delete_all`   | POST   | Delete all sessions server-side        |

## Dependencies

- **`DeepSeekPOW`** (`providers/deepseek/pow.js`): WASM-based proof-of-work solver
- **`CookieJar`** (`utils/cookie-jar.js`): Cookie persistence across requests
- **`readSSE`** (`utils/sse-reader.js`): SSE stream parser (1MB buffer cap, `[DONE]` detection)

## Flow

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

## DeepSeek SSE Event Format

| Event Type          | Shape                                                                      | Action                           |
| ------------------- | -------------------------------------------------------------------------- | -------------------------------- |
| SET/FINISHED        | `{"o":"SET","v":"FINISHED"}`                                               | Stream complete                  |
| BATCH (token usage) | `{"o":"BATCH","v":[{"p":"accumulated_token_usage","v":N}]}`                | Track token count                |
| Message response    | `{"v":{"response":{"message_id":"...","fragments":[{"content":"text"}]}}}` | Capture parent msg ID, scan text |
| Bare text delta     | `{"v":"text"}`                                                             | Scan text delta                  |
| Error               | `{"type":"error","content":"reason"}`                                      | Retry once, then send error      |

## Session Object Shape

```json
{
  "name": "2026-07-06 10:30",
  "chatSessionId": "abc123...",
  "parentMessageId": "xyz789...",
  "createdAt": "2026-07-06T10:30:00.000Z",
  "lastUsed": "2026-07-06T10:35:00.000Z",
  "disableTools": false,
  "model": "default",
  "dynamicToolsHash": null,
  "todos": {}
}
```
