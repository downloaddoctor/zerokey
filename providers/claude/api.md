# Claude Provider — Internal Reference

> Public contract (models, reasoning labels, prompt limit): see [`openapi.json`](../../openapi.json) and `GET /docs`.

## Object: `ClaudeAPI` (`providers/claude/api.js`)

Manages HTTP requests to `claude.ai/api` using browser-identical headers in **exact HAR order**. Cloudflare fingerprints header order — all requests must match real browser capture precisely.

## Internal API Endpoints Used

| Endpoint                                                          | Method | Purpose                               |
| ----------------------------------------------------------------- | ------ | ------------------------------------- |
| `/api/organizations/{orgId}/chat_conversations/{uuid}/completion` | POST   | Send chat completion (SSE stream)     |
| `/api/organizations/{orgId}/chat_conversations/{uuid}`            | DELETE | Delete a single conversation          |
| `/api/account_profile`                                            | PUT    | Set custom instructions (hash-cached) |

## Dependencies

- **`CookieJar`** (`utils/cookie-jar.js`): Cookie persistence
- **`readSSE`** (`utils/sse-reader.js`): SSE stream parser
- **`setClaudeInstructions`** (`providers/claude/set-instructions.js`): PUT account_profile for custom instructions (hash-cached)
- **`acquireSlot`** (`utils/rate-limiter.js`): 5 req / 15s sliding window rate limiter

## Flow

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
   emits an ask MHI with provider-switch options, sets waitUntil on userData,
   then calls process.exit(0). On hard exceeded errors, emits ask MHI in SSE and exits.
   Switching Claude users requires restarting the server.
```

## Claude SSE Event Format

| Event Type          | Shape                                                                                       | Action                                                  |
| ------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| message_start       | `{"type":"message_start","message":{"uuid":"..."}}`                                         | Capture parent msg UUID                                 |
| content_block_delta | `{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}`                 | Scan text delta delegate to route callback if >= 90%    |
| message_limit       | `{"type":"message_limit","message_limit":{"type":"...","windows":{"5h":{...},"7d":{...}}}}` | Check utilization, delegate to route callback if >= 90% |
| message_stop        | `{"type":"message_stop"}`                                                                   | Stream complete, sendFinalChunk                         |
| error               | `{"type":"error","error":{"type":"overloaded_error","message":"..."}}`                      | Classify + send error                                   |

## Request Body Shape (sent to Claude API)

```json
{
  "prompt": "user message text",
  "timezone": "America/Los_Angeles",
  "personalized_styles": [
    {
      "type": "default",
      "key": "Default",
      "name": "Normal",
      "nameKey": "normal_style_name",
      "prompt": "Normal\n",
      "summary": "Default responses from Claude",
      "summaryKey": "normal_style_summary",
      "isDefault": true
    }
  ],
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

## Header Ordering (exact HAR order for Cloudflare fingerprint)

1. `accept` → `accept-encoding` → `accept-language`
2. `anthropic-anonymous-id` → `anthropic-client-platform` → `anthropic-client-sha` → `anthropic-client-version` → `anthropic-device-id`
3. `content-type` → `cookie` → `origin` → `priority` → `referer`
4. `sec-ch-ua` → `sec-ch-ua-mobile` → `sec-ch-ua-platform`
5. `sec-fetch-dest` → `sec-fetch-mode` → `sec-fetch-site`
6. `user-agent` → `x-activity-session-id`

## Session Object Shape

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
  "todos": {}
}
```

## Usage Limit Handling

When either the 5h or 7d usage window reaches >= 90% utilization, the stream handler
delegates to the route callback. The route requests a conversation summary from Claude,
emits an ask MHI with provider-switch options, sets `waitUntil` on userData, then calls
`process.exit(0)`. On hard exceeded errors (caught in the catch block), the route emits
an ask MHI directly in the SSE stream and exits. `userData.waitUntil` / `waitReason` are
consulted at startup in `SessionSelector.select()` — blocked users show "(limit reached)"
suffix and auto-switch to available users is offered.
