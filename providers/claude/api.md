# Claude Provider — Internal Reference

> Public contract (models, reasoning labels, prompt limit): see [`openapi.json`](../../openapi.json) and `GET /docs`.

## Transports

| Transport                          | Status                        | Endpoint                                                                                                                      | Codec                               |
| ---------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Connect-RPC** (`connect-rpc.js`) | **current** (2026 web client) | `POST /claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/{StreamTimeline,PerformAction,GetNewConversationDefaults}` | gRPC framing + schema-less protobuf |
| REST SSE (`api.js`)                | legacy fallback               | `POST /api/organizations/{org}/chat_conversations/{uuid}/completion`                                                          | JSON over `text/event-stream`       |

`transport.js#TRANSPORT` is resolved once from `CONFIG.CLAUDE_TRANSPORT` (`completion` default, `rpc` opt-in). `resolveTransport(parsedFetch)` forces `completion` for legacy captures (org id in URL path); old and new captures both work with `completion`. `createAPI(options, parsedFetch)` picks the client. `index.js#validateFetch` validates each shape separately.

## Connect-RPC transport (`providers/claude/connect-rpc.js`)

Body is base64/raw of one or more Connect frames: `[1 byte flags][4 byte BE length][protobuf]`.

### StreamTimeline request field map (recovered from HAR, round-trip exact)

| Field | Wire   | Value                                     |
| ----- | ------ | ----------------------------------------- |
| 1     | len    | conversation UUID                         |
| 3     | varint | 1 (request kind)                          |
| 4     | len    | settings message `{ field 6 varint = 1 }` |
| 5     | len    | locale, e.g. `en-US`                      |
| 6     | varint | 1 (flags)                                 |
| 8     | len    | timezone, e.g. `America/Chicago`          |

`buildStreamTimeline({conversationId, locale, timezone})` builds the request frame. Response frames decode via `walkProto` (varint + length-delimited; valid UTF-8 → string, JSON → object, else recurse). HAR binary bodies are latin1/base64, never UTF-8.

Required headers: `content-type: application/connect+proto`, `connect-protocol-version: 1`, `connect-accept-encoding: gzip`, `anthropic-client-build`, `anthropic-client-platform: web_claude_ai`, `x-organization-uuid` (org id — RPC captures carry no org path in the URL), plus `cookie`.

### Stream lifecycle

`StreamTimeline` is a **long-lived subscription**, not a one-shot request. The HAR shows ONE stream held open across three user messages (619 s), with `PerformAction` POSTs interleaved; it reopens after idle. So:

- `openTimeline()` starts the stream and returns `{next(), close(), conversationId}`; `next()` reads frames incrementally as they arrive (split-frame safe via `makeFrameReader`).
- `timeline(conversationId)` returns the client's **persistent** handle, opening once and reusing it across turns; it reopens if the prior stream closed.
- `sendMessage()` runs: GetNewConversationDefaults → promptless PerformAction → StreamTimeline → wait for session id (`/1/1/20/1/1`) → prompt PerformAction (seq counter) → read until the usage frame (`done`). Deltas stream via `onText`/`onReasoning`.
- `f15` is `PerformAction.header.deviceSigning` (proto field 15), a **device-bound signature**, not a message-level blob. In the bundle the flow is: send PerformAction with an empty `deviceSigning` → server returns `deviceSignatureAsk` in the response → the client calls `sign(deviceSignatureAsk, actionCase)` on a registered signer → resend the same action with `deviceSigning` set. The signature is produced by a device key the browser holds (TPM / IndexedDB / native bridge — not the main bundle; `crypto.subtle` in the bundle only does SHA-256). The gating check `EJ(e,t)` bails early with `{kind:'skip',reason:'not_desktop_app'}` when `t.isDesktopApp` is false, so plain web clients do not sign.
- BLOCKED (workaround): without the signer, `actionSignature()` throws unless `ZEROKEY_CLAUDE_F15_PROBE=zero` (empty 32 bytes) or `=random` is set. Set `=zero` and try a live send: the server may accept an empty signature for web-style requests; if it asks (`deviceSignatureAsk`), RPC is unusable without the key and `CLAUDE_TRANSPORT=completion` remains the only way to send.

Only `StreamTimeline` is Connect-framed (`application/connect+proto`). `PerformAction` and `GetNewConversationDefaults` are bare protobuf (`application/proto`).

### Response decoding

Connect frames carry a flags byte: **bit 0 = gzip**. A flags=1 frame's payload gunzips to the StreamTimeline timeline. Recovered block model:

| Object        | Prefix  | Fields                                                                          |
| ------------- | ------- | ------------------------------------------------------------------------------- |
| Message group | `dgrp_` | f1 id, f2 conversation, f4 role (1=human, 2=assistant), f5 label                |
| Content block | `cblk_` | f2 parent group, f4 type, **f9 = text**, f12 = reasoning, f5 = "Thought for Ns" |

`collectContent(decoded)` returns `{text:[], reasoning:[]}` in order. `rpc-stream-handler.js` forwards these through `pipeline.scan` (text) and the reasoning channel, mirroring the legacy SSE handler. `sendMessage({conversationId, prompt})` runs PerformAction then StreamTimeline and returns decoded blocks.

### Router wiring

Only the **streaming reply** differs by transport. `router.js` branches on `transport === 'rpc'` for the turn: it calls `claudeApi.sendMessage` and `rpcStreamHandler` streams the reply. Everything else is shared and unchanged — instructions (`setClaudeInstructions`, REST `PUT /api/account_profile`), the tool loop, loop-guard, and SSE framing run identically for both transports.

## Legacy transport: `ClaudeAPI` (`providers/claude/api.js`)

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
1. initializeFromJSON(parsedFetch) → extract headers, orgId (URL path → x-organization-uuid header → lastActiveOrg cookie), seed CookieJar
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
emits an ask MHI with provider-switch options, and sets `waitUntil` on userData. On hard
exceeded errors (a 429 whose body carries the usage-limit JSON), the route catch parses
the body — `assertOk` is called with `limit: 0` so the JSON is never truncated — writes
`userData.waitUntil` / `waitReason`, and emits the ask MHI directly. `userData.waitUntil` /
`waitReason` are consulted at startup in `SessionSelector.select()` (blocked users show
"(limit reached)" and auto-switch is offered) and at the top of the route, which
short-circuits a still-blocked user with `emitLimitResponse` instead of hitting upstream.
