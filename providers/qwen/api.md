# Qwen Provider — Internal Reference

> Public contract (models, reasoning labels, prompt limit): see [`openapi.json`](../../openapi.json) and `GET /docs`.

## Object: `QwenAPI` (`providers/qwen/api.js`)

Manages HTTP requests to `chat.qwen.ai` using a captured browser session. Auth comes from a pasted DevTools `fetch()` capture: the `cookie` header's `token=<JWT>` value is the source of truth, with `authorization: Bearer <JWT>` used as a fallback if present. Anti-bot cookies (`cnaui`, `aui`, `sca`, `xlly_s`, `cna`, `ssxmod_itna*`) are seeded from the same capture and persisted via `CookieJar`.

## Internal API Endpoints Used

| Endpoint                               | Method | Purpose                                       |
| -------------------------------------- | ------ | --------------------------------------------- |
| `/api/v1/auths/`                       | GET    | Validate session, fetch profile, refresh JWT  |
| `/api/v2/chats/new`                    | POST   | Create a new chat, returns chat id            |
| `/api/v2/chat/completions?chat_id=...` | POST   | Send chat completion (SSE stream)             |
| `/api/v2/chats/:chatId`                | DELETE | Delete a chat session server-side             |
| `/api/v2/users/user/settings/update`   | POST   | Write ZeroKey instructions to personalization |

## Dependencies

- **`CookieJar`** (`utils/cookie-jar.js`): Cookie persistence across requests, captured from response headers each turn
- **`nodeFetch`**: HTTP client with a 300s timeout via `AbortController`

## Flow

```
1. initializeFromJSON(headers, body) → seed CookieJar, resolve bearer token
   (fails fast if neither cookie token= nor authorization header present)
2. createChatSession(modelId, { skipDelay }) → POST /api/v2/chats/new → returns chat id
   (awaits humanDelay 3-9s unless skipDelay; getCurrentUser passes skipDelay: true)
3. getCurrentUser() → GET /api/v1/auths/ → returns profile ({ id, email, name, role, tier, token, ... })
   (refreshed JWT kept in-memory only via _setToken — never persisted to users.json)
4. chatCompletion(chatSessionId, prompt, parentMessageId, { model }):
   a. Builds payload with feature_config (thinking_enabled/auto_search default true — mirrors Qwen's "Auto" UI mode)
   b. POST /api/v2/chat/completions?chat_id=... → SSE stream
   c. Awaits humanDelay 3-9s before firing
5. Stream parsed by providers/qwen/stream-handler.js (mirrors DeepSeek/Claude reasoning_content pattern)
6. deleteSession(chatSessionId) → DELETE /api/v2/chats/:chatId (used in ephemeral mode cleanup)
```

Qwen models: `qwen3.7-plus`, `qwen3.8-max`, `qwen3.7-max` (no vision), `qwen3.6-plus`, `qwen3.5-plus`, `qwen3.5-omni-plus` — see `openapi.json` `x-prompt-limits` and model metadata for context/output limits.

## Session Object Shape

```json
{
  "name": "2026-07-06 10:30",
  "chatSessionId": "chat-id-here",
  "parentMessageId": "msg-id-here",
  "createdAt": "2026-07-06T10:30:00.000Z",
  "lastUsed": "2026-07-06T10:35:00.000Z",
  "disableTools": false,
  "model": "qwen3.7-plus",
  "dynamicToolsHash": null,
  "todos": {}
}
```
