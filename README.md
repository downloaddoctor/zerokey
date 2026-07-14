# ZeroKey

OpenAI-compatible local AI proxy for **DeepSeek**, **Claude**, and **ChatGPT** — use your own browser sessions and your own credentials to connect your own accounts with VS Code, Terax, or OpenCode. Personal use only. Just paste a fetch() call from DevTools. ZeroKey does not provide shared accounts, API access, or commercial access to third-party services.

> **Using with tools?** On the first message of a new session the LLM reads `AGENTS.md` for project context, runs `git status/diff`, and asks whether to continue before making any changes. Powered by **[skills-extra.md](lib/engine/skills-extra.md)**. If it stops using BPF tools, say: **"Use BPF only."** — or restart and create a fresh session.

## Features

- **OpenAI-compatible** — drop-in replacement for `/v1/models` and `/v1/chat/completions`
- **Three providers** — DeepSeek, Claude, and ChatGPT — switch at startup
- **Streaming** — SSE response streaming for all providers
- **Multi-IDE** — per-request IDE selection via `Authorization: Bearer <vscode|terax|opencode>`
- **Session persistence** — in-memory session tracking; flushed to disk on graceful shutdown
- **Tool call support** — integrated ToolCompiler translates OpenAI-style function calling into provider-compatible prompt grammar

## Quick Start

```bash
git clone https://github.com/downloaddoctor/zerokey.git
cd zerokey
npm install
npm start
# or on Windows
start.bat
```

On startup, the interactive wizard guides you through:
1. **Provider** — DeepSeek, Claude, or ChatGPT
2. **User** — paste a `fetch()` call from browser DevTools (captures headers + browser fingerprint)
3. **Session** — pick or create a chat session

The server auto-finds an available port starting from `8000` and prints the endpoint URLs.

## Endpoints

| Method | Path                   | Description                      |
| ------ | ---------------------- | -------------------------------- |
| `GET`  | `/`                    | API info & available models      |
| `GET`  | `/health`              | Health check (uptime, timestamp) |
| `GET`  | `/v1/models`           | List available models            |
| `GET`  | `/v1/models/:model`    | Get specific model details       |
| `POST` | `/v1/chat/completions` | Chat completion (streaming)      |

Full API reference: **[API.md](API.md)**

## Account and Credential Responsibility

ZeroKey requires users to provide their own browser session data captured from
their own accounts. This project does not include, distribute, or request
credentials from other users.

Only use sessions and credentials belonging to you, and ensure your usage
complies with the Terms of Service of each connected provider.

### Getting Credentials

### DeepSeek
1. Open DevTools → Network tab
2. Visit `chat.deepseek.com` and start a conversation
3. Find a request to `/api/v0/chat/completion`
4. Right-click → Copy → Copy as fetch (Node.js)
5. Paste into the startup wizard

### ChatGPT
1. Open DevTools → Network tab
2. Visit `chatgpt.com` and start a conversation
3. Find a request to `/backend-api/f/conversation`
4. Right-click → Copy → Copy as fetch (Node.js)
5. Paste into the startup wizard

### Claude
1. Open DevTools → Network tab
2. Visit `claude.ai` and start a conversation
3. Find a request to `/api/organizations/.../chat_conversations/.../completion`
4. Right-click → Copy → Copy as fetch (Node.js)
5. Paste into the startup wizard

## IDE Integration

### Bearer Tokens

The `Authorization: Bearer <ide>` header maps the request to the correct IDE's tool definitions. Default is `vscode` if omitted.

| IDE     | Bearer Token    | Purpose             |
| ------- | --------------- | ------------------- |
| VS Code  | `Bearer vscode`   | Loads VS Code tools  |
| Terax   | `Bearer terax`   | Loads Terax tools    |
| OpenCode| `Bearer opencode` | Loads OpenCode tools |

### VS Code — LLM Gateway

1. Install [GitHub Copilot LLM Gateway](https://marketplace.visualstudio.com/items?itemName=AndrewButson.github-copilot-llm-gateway)
2. F1 → Manage Language Model → Add models → LLM Gateway
3. URL: `http://localhost:8000/v1` → API key: `vscode`

### VS Code — Built-in

1. F1 → Manage Language Model → Add models → Custom Endpoint
2. Select Chat Completions → API key: `vscode`
3. Copy **[models.json](config/models.json)** contents into the auto-opened VS Code models file

### Terax

1. Settings → Models → Add Provider → OpenAI Compatible
2. Base URL: `http://localhost:8000/v1`
3. API key: `terax`
4. Click Test — worked? Done.

## Architecture

```
server.js               → Express app, startup wizard, provider router mounting, port selection
API.md                  → full API reference with provider internals, SSE formats, schemas
config/
  constants.js          → PORT, MODELS
  models.json           → IDE model definitions for VS Code built-in
routes/
  deepseek.js           → DeepSeek chat completion route
  claude.js             → Claude chat completion route
  chatgpt.js            → ChatGPT chat completion route
  models.js             → /v1/models and /v1/models/:model endpoints
  health.js             → /health endpoint
core/
  chat-router.js        → builds the Express router for the selected provider
  session-selector.js   → inquirer wizard, fetch() parser, users.json persistence, Claude "(limit reached)" suffix, auto-switch to available users
  deepseek/
    api.js              → POW + HTTPS request builder
    pow.js              → WASM SHA3 solver
    stream-handler.js   → SSE stream → OpenAI delta chunks
    wasm/               → compiled WASM binary
  chatgpt/
    api.js              → sentinel token + conduit request builder
    pow.js              → pure JS SHA3-512 solver
    stream-handler.js   → SSE stream → OpenAI delta chunks, delegates rate-limit to route callback
    set-instructions.js → system prompt injection for ChatGPT
  claude/
    api.js              → HAR auth + Cloudflare header ordering
    stream-handler.js   → SSE stream → OpenAI delta chunks, delegates rate-limit to route callback
    set-instructions.js → system prompt injection for Claude
lib/engine/
  index.js              → ToolCompiler singleton: formatPrompt, buildPrompt, parse, emit, compile, inferType
  dynamic-tools.js      → runtime tool resolution, grammarFromSchema, syncDynamicTools
  tool-defs.js          → TOOLS registry, getIDEMapper, IDES_PROMPT_OPTIMIZER, RAW_EDIT, reverseMap
  stream.js             → 3-state SSE parser (outside/toolStartFound/inTool), ⟦tool¦param⟧ detection, flush→OpenAI deltas
  instructions.js       → system prompt loader (reads instructions.md + skills-extra.md)
  instructions.md       → BPS tool grammar + system prompt injected on new sessions
  skills-extra.md       → memory and save workflow for agent sessions
  templates/
    opencode.json       → Opencode IDE tool definitions
    terax.json          → Terax IDE tool definitions
    vscode.json         → VS Code IDE tool definitions
utils/
  cookie-jar.js         → shared cookie management for all providers (seed, capture, toString)
  errors.js             → 9-category error classifier + OpenAI-format error factory
  har-to-capture.js     → HAR file → fetch() converter
  rate-limiter.js       → 5 req/15s sliding window per provider label
  sse-reader.js         → unified SSE reader for Web ReadableStream (1MB buffer cap, [DONE] detection)
  stream-helpers.js     → sendFinalChunk (once-guard flush+emit+[DONE]), createOnError (writes error JSON to SSE)
```

## Session Storage

Sessions and credentials are stored in `temp/users.json` (gitignored). Each user entry contains the captured browser headers and a list of named sessions with conversation IDs. Sessions are tracked in-memory during runtime and flushed to disk on graceful shutdown (`SIGINT`/`SIGTERM`). No per-request disk writes.

Full schema details: **[API.md](API.md)**

## Legal Use

ZeroKey is a self-hosted personal-use tool. It is intended for individuals using
their own browser sessions, their own credentials, and their own third-party
accounts.

Users are responsible for following the Terms of Service of any third-party
service they connect to, including DeepSeek, OpenAI/ChatGPT, and Anthropic/Claude.

ZeroKey does not provide access to third-party accounts, does not include shared
credentials, and is not intended to operate as a hosted commercial service.

## License

ZeroKey Non-Commercial License — personal use only. See [LICENSE](LICENSE) for full terms.
