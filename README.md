# ZeroKey

OpenAI-compatible local AI proxy for **DeepSeek**, **ChatGPT**, and **Claude** — pipe any of them into VS Code or Terax using your real browser session. No API key. No subscription. Just paste a fetch().

## Features

- **OpenAI-compatible** — drop-in replacement for `/v1/models` and `/v1/chat/completions`
- **Three providers** — DeepSeek, ChatGPT, and Claude — switch at startup
- **Real browser fingerprint** — POW solving, sentinel tokens, conversation prepare, Cloudflare-safe header ordering, cookie management
- **Streaming** — SSE response streaming for all providers
- **Multi-IDE** — per-request IDE selection via `Authorization: Bearer <vscode|terax>`
- **Session persistence** — save & resume chat sessions across restarts
- **Tool call support** — integrated ToolCompiler translates OpenAI-style function calling into provider-compatible prompt grammar

## Quick Start

```bash
git clone https://github.com/downloaddoctor/zerokey.git
cd zerokey
npm install
npm start
```

On startup, the interactive wizard guides you through:
1. **Provider** — DeepSeek, ChatGPT, or Claude
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

## Getting Credentials

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

Set `Authorization: Bearer <ide>` in your client config. Default is `vscode` if omitted.

| IDE     | Bearer Token    |
| ------- | --------------- |
| VS Code | `Bearer vscode` |
| Terax   | `Bearer terax`  |

### VS Code (Copilot Chat)

Use ZeroKey as a model provider in Copilot Chat via the **LLM Gateway** extension:

1. Install [GitHub Copilot LLM Gateway](https://marketplace.visualstudio.com/items?itemName=AndrewButson.github-copilot-llm-gateway) from the VS Code marketplace
2. Open Copilot Chat → click the model picker → **Select a language model**
3. Click the settings icon (⚙️) in the language model picker
4. Under **Add models**, select **LLM Gateway**
5. Enter your ZeroKey server URL (e.g. `http://localhost:8000/v1`) and `vscode` for the API key
6. The available models from ZeroKey will now appear in the model picker

### Terax

Set `Authorization: Bearer terax` in your Terax client config pointing to `http://localhost:8000/v1`.

### Generic Client Configuration

```json
{
  "provider": "openai",
  "apiBase": "http://localhost:8000/v1",
  "apiKey": "not-needed",
  "model": "deepseek"
}
```

Set `model` to `deepseek`, `chatgpt`, or `claude` to match the provider selected at startup.

## Architecture

```
server.js               → Express app, startup wizard, provider dispatch, port selection
config/constants.js     → PORT, MODELS, MODEL_ALIASES
routes/                 → chatgpt.js, claude.js, deepseek.js, models.js, health.js
core/
  deepseek/             → api.js (POW + HTTPS), pow.js (WASM SHA3-512), stream-handler.js
  chatgpt/              → api.js (sentinel + conduit), pow.js (pure JS SHA3-512), stream-handler.js
  claude/               → api.js (HAR auth + Cloudflare headers), stream-handler.js
  session-selector.js   → inquirer wizard, fetch() parser, users.json persistence
lib/engine/
  index.js              → ToolCompiler singleton, prompt formatting
  tool-defs.js          → IDE tool mappings, prompt grammar, RAW_EDIT transforms
  stream.js             → SSE parser, ⟦tool¦param⟧ marker detection, tool buffering
  instructions.md       → system prompt injected on new sessions
  extra-tools.js        → VSCode-only tool definitions
  templates/            → opencode.json, terax.json, vscode.json
utils/
  cookie-jar.js         → shared cookie management for all providers
  errors.js             → OpenAI-format error factory
```

## Session Storage

Sessions and credentials are stored in `temp/users.json` (gitignored). Each user entry contains the captured browser headers and a list of named sessions with conversation IDs.

## License

MIT
