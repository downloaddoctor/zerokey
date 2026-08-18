<p align="center">
  <img alt="ZeroKey preview" src="https://github.com/user-attachments/assets/f401c888-2a86-4b0e-a0f1-2900f2824b91" width="979" height="512">
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#api-endpoints">API Docs</a> ·
  <a href="docs/llms.txt">llms.txt</a> ·
  <a href="https://downloaddoctor.github.io/zerokey/">Landing Page</a>
</p>

<video src="https://github.com/user-attachments/assets/688e1119-1455-4f3f-b9a4-f423aa1dde23" autoplay muted loop playsinline width="100%"></video>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Non--Commercial-blue"></a>
  <a href="package.json"><img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen"></a>
  <a href="package.json"><img alt="pnpm" src="https://img.shields.io/badge/pnpm-10.13.1-orange"></a>
  <a href="#quick-start"><img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-yes-8b7bff"></a>
  <img alt="Telemetry" src="https://img.shields.io/badge/telemetry-none-8b7bff">
</p>

# ZeroKey

OpenAI-compatible local AI proxy for **DeepSeek**, **Claude**, and **ChatGPT** — use your own browser sessions and your own credentials to connect your own accounts with VS Code (Chat), Terax, or OpenCode. Personal use only. Just paste a fetch() call from DevTools. ZeroKey does not provide shared accounts, API access, or commercial access to third-party services.

> **Is it safe? How do I start?** See [llms.txt](docs/llms.txt) for a short, machine-readable summary, or the [landing page](https://downloaddoctor.github.io/zerokey/).

> **Heads up:** ZeroKey is per-session — one server process is pinned to the session picked at
> startup. Switching sessions or opening a new chat window in your IDE does **not** refresh which
> session ZeroKey talks to; restart the server and re-select to pick up a different session.

> **Using ZeroKey:** on first message, model reads the target
> project's `AGENTS.md` (if present) for context. Built-in tools (`read`, `write`, `replace`,
> `ls`, `mkdir`, `glob`, `grep`, `cmd`, `cmd_bg`, `cmd_poll`, `cmd_kill`, `fetch`, `errors`,
> `todos_add`, `todos_set`, `ask`) and any MCP tools registered via `tools[]` in the request
> work out of the box if enabled — see [MCP & Custom Skills](#mcp--custom-skills). If model stops using tools correctly, say: **"Use BPI only."**

## Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Getting Credentials](#getting-credentials)
- [IDE Integration](#ide-integration)
- [API Endpoints](#api-endpoints)
- [MCP & Custom Skills](#mcp--custom-skills)
- [Session Storage](#session-storage)
- [License](#license)

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

| OS            | Download                                                                                        | Run                                   |
| ------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| Windows       | [⬇ zerokey.bat](https://github.com/downloaddoctor/zerokey/releases/latest/download/zerokey.bat) | double-click to run                   |
| Linux / macOS | [⬇ zerokey.sh](https://github.com/downloaddoctor/zerokey/releases/latest/download/zerokey.sh)   | `chmod +x zerokey.sh && ./zerokey.sh` |

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

The server auto-finds an available port starting from `7250` and prints the endpoint URLs.

## Getting Credentials

ZeroKey requires users to provide their own browser session data captured from their own
accounts. This project does not include, distribute, or request credentials from other users.
Only use sessions and credentials belonging to you, and ensure your usage complies with the Terms
of Service of each connected provider.

Pick whichever provider you chose in the setup wizard:

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

VS Code (actively tested), Terax, and OpenCode are all tested and working.

### Bearer Tokens

The `Authorization: Bearer <ide>` header maps the request to the correct IDE's tool definitions. Default is `vscode` if omitted.

| IDE      | Bearer Token      | Purpose              |
| -------- | ----------------- | -------------------- |
| VS Code  | `Bearer vscode`   | Loads VS Code tools  |
| Terax    | `Bearer terax`    | Loads Terax tools    |
| OpenCode | `Bearer opencode` | Loads OpenCode tools |

### VS Code — Built-in

1. Server prints the model name to select in the console.
2. Open VS Code Chat → pick that model from the dropdown.
3. The model appears under the **ZeroKey** provider.

### Terax

1. Settings → Models → Add Provider → OpenAI Compatible
2. Base URL: `http://localhost:7250/v1`
3. API key: `terax`
4. Click Test — worked? Done.

### OpenCode

1. Manage Models → Add Provider → Custom OpenAI-compatible
2. Base URL: `http://localhost:7250/v1`
3. API key: `opencode`
4. Submit — worked? Done.

## API Endpoints

| Method | Path                   | Description                      |
| ------ | ---------------------- | -------------------------------- |
| `GET`  | `/`                    | API info & available models      |
| `GET`  | `/health`              | Health check (uptime, timestamp) |
| `GET`  | `/v1/models`           | List available models            |
| `GET`  | `/v1/models/:model`    | Get specific model details       |
| `POST` | `/v1/chat/completions` | Chat completion (streaming)      |

Full API reference: **[API.md](API.md)**

## MCP & Custom Skills

ZeroKey's tool layer is extensible past the built-in BPI tools.

- **MCP auto-registration** — tools named `mcp_<server>_<tool>` in the request's `tools[]` are
  auto-registered under a `$<server>` skill tag. No manual wiring required.
- **Built-in Playwright MCP** — a Playwright alias map ships out of the box under `$browser`.
- **Inspect what's registered** — ask the agent `$mcp` to list currently registered MCP tags for
  the session, or `$mcp-dump` to dump the full alias map as JSON.
- **Custom skills** — built-in skills (`$save`, `$test`, `$browser`, `$cwd`, `$mcp`, `$mcp-dump`)
  are entries in `engine/triggers.js` — each is a trigger word plus a BPI template. Add a new
  entry to teach the agent a new skill.
- **Per-IDE tool grammar** — the same tool set compiles differently per IDE (VS Code, Terax,
  OpenCode) from one shared definition in `engine/tool-defs.js`.

## Session Storage

Sessions and credentials are stored in `temp/users.json` (gitignored). Each user entry contains the captured browser headers and a list of named sessions with conversation IDs. Sessions are tracked in-memory during runtime and flushed to disk on graceful shutdown (`SIGINT`/`SIGTERM`). No per-request disk writes.

Full schema details: **[API.md](API.md)**

## License

ZeroKey Non-Commercial License — personal use only. See [LICENSE](LICENSE) for full terms.
