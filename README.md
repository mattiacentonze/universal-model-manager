# opencode-universal-auth

Unified authentication, runtime fallback, and ChatGPT Web integration for [OpenCode](https://opencode.ai).

`opencode-universal-auth` combines the power of:
1. **OpenAI OAuth** (via `@cortexkit/opencode-openai-auth`): Use your ChatGPT Plus/Pro subscription natively in OpenCode without API fees.
2. **ChatGPT Web Provider**: Connect OpenCode directly to your authenticated ChatGPT Web session via a local loopback bridge.
3. **Runtime Fallback Engine** (via `opencode-runtime-fallback`): Seamlessly switch to backup models on rate limits, quota exhaustion, or service failures.

---

## Quick Start

### 1. Installation

Install the package into your OpenCode configuration directory or globally:

```bash
cd ~/.config/opencode
npm install opencode-universal-auth
```

### 2. Automatic Configuration

Run the setup wizard to automatically register the plugin and the `chatgpt-web` provider in your `opencode.jsonc`:

```bash
npx universal-auth setup
```

### 3. Log In

- **For OpenAI OAuth (Codex backend)**:
  Inside OpenCode, run:
  ```text
  /login openai
  ```
- **For ChatGPT Web (Browser backend)**:
  Run the interactive browser login:
  ```bash
  npx universal-auth login chatgpt-web
  ```
  A Google Chrome window will open. Log in to your ChatGPT account. Once logged in, session credentials will be saved securely to `~/.config/opencode/universal-auth/chatgpt-storage-state.json` (with `0600` permissions).

---

## Configuration

In `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-universal-auth"
  ],
  "model": "openai/gpt-6-astra",
  "provider": {
    "chatgpt-web": {
      "npm": "@ai-sdk/openai",
      "name": "ChatGPT Web",
      "options": {
        "baseURL": "http://127.0.0.1:17842/v1",
        "apiKey": "local-session"
      },
      "models": {
        "chatgpt-web/auto": {
          "name": "ChatGPT Web (Auto)"
        },
        "chatgpt-web/pro": {
          "name": "ChatGPT Web (Pro)"
        },
        "chatgpt-web/think": {
          "name": "ChatGPT Web (Think)"
        },
        "chatgpt-web/luna": {
          "name": "ChatGPT Web (Luna)"
        }
      }
    }
  },
  "agent": {
    "build": {
      "fallback_models": [
        "chatgpt-web/auto",
        "google/antigravity-gemini-3.8-flash"
      ]
    }
  }
}
```

---

## Submodule Entrypoints

If you prefer loading individual components independently, `opencode-universal-auth` exposes separate entrypoints:

- `opencode-universal-auth` (All-in-one: OpenAI OAuth + Fallback + ChatGPT Web bridge)
- `opencode-universal-auth/openai` (OpenAI OAuth only)
- `opencode-universal-auth/fallback` (Runtime Fallback engine only)
- `opencode-universal-auth/chatgpt-web` (ChatGPT Web provider & bridge only)

---

## CLI Commands

The package includes the `universal-auth` CLI:

| Command | Description |
|---|---|
| `universal-auth status` | Show status of config, OAuth account, and ChatGPT Web session |
| `universal-auth login chatgpt-web` | Open browser window to authenticate with ChatGPT |
| `universal-auth setup` | Idempotently update `opencode.jsonc` with provider definitions |
| `universal-auth bridge [--port 17842]` | Manually start the local loopback bridge daemon |

---

## In-TUI Slash Commands

Inside OpenCode, the following commands are available:

- `/login openai`: Authenticate via ChatGPT Plus/Pro OAuth
- `/universal-status`: Inspect status of all universal auth subsystems
- `/universal-chatgpt-web status`: Check ChatGPT Web bridge and session status
- `/universal-chatgpt-web login`: Trigger browser login
- `/openai-quota`, `/openai-account`, `/openai-routing`: Native quota and account management

---

## Architecture & Security Model

- **Loopback-Only**: The local bridge binds strictly to `127.0.0.1`. Remote network connections are rejected.
- **Credential Safety**: ChatGPT Web cookies and tokens are stored in a private directory with `0o600` permissions. No credentials are transmitted to third parties.
- **Browser-Only v1**: The initial release operates purely in browser-only mode (text streaming and responses), without local shell or filesystem access from ChatGPT Web turns, eliminating prompt-injection file-modification vectors.
- **Fail-Closed**: Missing models or network interruptions fail explicitly with clean error messages for the fallback engine to catch.

---

## License

MIT (see [LICENSE](LICENSE)). Built upon works from `@cortexkit/opencode-openai-auth`, `opencode-runtime-fallback`, and `codex-chatgpt-web`.
