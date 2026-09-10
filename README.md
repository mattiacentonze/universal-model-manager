# opencode-universal-auth

Unified authentication, runtime fallback, and ChatGPT Web integration for [OpenCode](https://opencode.ai).

`opencode-universal-auth` replaces fragmented plugins by combining:
1. **OpenAI OAuth** (Codex backend): Use your ChatGPT Plus/Pro subscription natively in OpenCode without pay-as-you-go API keys.
2. **Google / Antigravity OAuth**: Direct access to Gemini 3 / Claude models via Antigravity credentials.
3. **ChatGPT Web Provider**: Access ChatGPT Web via a local loopback bridge with temporary chat isolation and streaming.
4. **Runtime Fallback Engine**: Automatic model replay across all configured providers on rate limits (429), quota exhaustion, or 5xx server errors.
5. **Unified TUI Sidebar**: Displays OpenAI quota (5h / weekly), Antigravity credits, and ChatGPT Web session status in OpenCode's right sidebar.

---

## Quick Start

### 1. Installation

Install the package into your OpenCode configuration directory or globally:

```bash
cd ~/.config/opencode
npm install opencode-universal-auth
```

### 2. One-Command Setup

Run the setup wizard to configure `opencode.jsonc` and `tui.json`, automatically superseding the legacy plugins:

```bash
npx universal-auth setup
```

### 3. Log In

- **OpenAI (Codex)**:
  ```text
  /login openai
  ```
- **Google / Antigravity**:
  ```text
  /login google
  ```
- **ChatGPT Web**:
  ```bash
  npx universal-auth login chatgpt-web
  ```
  A Google Chrome window opens. Log in to your ChatGPT account. Session credentials are saved with restrictive `0600` permissions.

---

## Configuration

In `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-universal-auth",
    "opencode-universal-auth/antigravity"
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

In `tui.json`:

```json
{
  "plugin": [
    "opencode-universal-auth"
  ]
}
```

---

## Submodule Entrypoints

- `opencode-universal-auth`: OpenAI OAuth + Fallback + ChatGPT Web bridge
- `opencode-universal-auth/antigravity`: Google / Antigravity OAuth
- `opencode-universal-auth/openai`: OpenAI OAuth only
- `opencode-universal-auth/fallback`: Runtime Fallback only
- `opencode-universal-auth/chatgpt-web`: ChatGPT Web bridge only
- `opencode-universal-auth/tui`: Unified TUI sidebar widget

---

## TUI Sidebar & Quota Information

In OpenCode's right-hand sidebar, `opencode-universal-auth` renders:

1. **OpenAI Widget**:
   - 5-hour rolling quota (%)
   - Weekly quota (%)
   - Active account and routing strategy
2. **Antigravity Widget**:
   - Gemini & Claude credit/quota usage
   - Active account tier
3. **ChatGPT Web Widget**:
   - Status: Active (Logged In) / Logged Out
   - Recent turns count (in active 3-hour rolling window)
   - Rate-limit reset indicator if ChatGPT hits a temporary throttle

---

## CLI Commands

| Command | Description |
|---|---|
| `universal-auth status` | Show status of config, OAuth account, and ChatGPT Web session |
| `universal-auth login chatgpt-web` | Open browser window to authenticate with ChatGPT |
| `universal-auth setup` | Idempotently update `opencode.jsonc` and `tui.json` |
| `universal-auth bridge [--port 17842]` | Manually start the local loopback bridge daemon |

---

## License

MIT (see [LICENSE](LICENSE)). Built upon works from `@cortexkit/opencode-openai-auth`, `@cortexkit/opencode-antigravity-auth`, `opencode-runtime-fallback`, and `codex-chatgpt-web`.
