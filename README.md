# ZeroKey

<video src="https://github.com/user-attachments/assets/6c32c6f7-564f-4e63-bbc1-2e73b1566881" autoplay muted loop playsinline width="100%"></video>

OpenAI-compatible local AI proxy for **DeepSeek**, **Claude**, and **ChatGPT** — use your own browser sessions and your own credentials to connect your own accounts with VS Code (Chat), Terax, or OpenCode. Personal use only. Just paste a fetch() call from DevTools. ZeroKey does not provide shared accounts, API access, or commercial access to third-party services.

> **Using with tools?** On the first message of a new session the LLM reads `AGENTS.md` for project context, runs `git status/diff`, and asks whether to continue before making any changes. Powered by **[skills-extra.md](lib/engine/skills-extra.md)**. If it stops using BPI tools, say: **"Use BPI only."** — or restart and create a fresh session.

> **Predefined tools** — built-in BPI tools work out of the box: `read`, `write`, `replace`, `ls`, `mkdir`, `glob`, `grep`, `cmd`, `cmd_bg`, `cmd_poll`, `cmd_kill`, `fetch`, `errors`, `todos_add`, `todos_set`, `ask`; MCP tool passthrough is planned and will be enabled in a future release

> **Note:** Currently only VS Code Custom Endpoint is actively tested. Other IDE integrations (Terax, OpenCode) are supported in code but not yet verified.

## Features

- **OpenAI-compatible** — drop-in replacement for `/v1/models` and `/v1/chat/completions`
- **Three providers** — DeepSeek, Claude, and ChatGPT — switch at startup
- **Streaming** — SSE response streaming for all providers
- **Multi-IDE** — per-request IDE selection via `Authorization: Bearer <vscode|terax|opencode>`
- **Session persistence** — in-memory session tracking; flushed to disk on graceful shutdown
- **Tool call support** — integrated ToolCompiler translates OpenAI-style function calling into provider-compatible prompt grammar

## Quick Start

### One-click launcher

Download the latest launcher for your OS from the **[Releases page](https://github.com/downloaddoctor/zerokey/releases/latest)**:

- **Windows:** [⬇ zerokey.bat](https://github.com/downloaddoctor/zerokey/releases/latest/download/zerokey.bat) — double-click to run
- **Linux / macOS:** [⬇ zerokey.sh](https://github.com/downloaddoctor/zerokey/releases/latest/download/zerokey.sh) — run `chmod +x zerokey.sh && ./zerokey.sh`

Place the script in any folder and run it. It will:

- Clone the repo (first run only)
- Install dependencies
- Check for updates on every launch
- Start the server

> **Prerequisites:** [Git](https://git-scm.com/download/win) and [pnpm](https://pnpm.io/installation) must be installed.

### Manual setup

```bash
git clone https://github.com/downloaddoctor/zerokey.git
cd zerokey
pnpm install
pnpm start
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

| IDE      | Bearer Token      | Purpose              |
| -------- | ----------------- | -------------------- |
| VS Code  | `Bearer vscode`   | Loads VS Code tools  |
| Terax    | `Bearer terax`    | Loads Terax tools    |
| OpenCode | `Bearer opencode` | Loads OpenCode tools |

### VS Code — Built-in

1. F1 → Manage Language Model → Add models → Custom Endpoint
2. Select Chat Completions → API key: `vscode`
3. Copy **[models.json](config/models.json)** contents into the auto-opened VS Code models file
4. In VS Code chat, select **ZK - 8000** (or whichever port ZeroKey is running on) as the active model

### Terax

1. Settings → Models → Add Provider → OpenAI Compatible
2. Base URL: `http://localhost:8000/v1`
3. API key: `terax`
4. Click Test — worked? Done.

## Session Storage

Sessions and credentials are stored in `temp/users.json` (gitignored). Each user entry contains the captured browser headers and a list of named sessions with conversation IDs. Sessions are tracked in-memory during runtime and flushed to disk on graceful shutdown (`SIGINT`/`SIGTERM`). No per-request disk writes.

Full schema details: **[API.md](API.md)**

## License

ZeroKey Non-Commercial License — personal use only. See [LICENSE](LICENSE) for full terms.
