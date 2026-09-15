# universal-model-manager

Unified **model manager** plugin for [OpenCode](https://opencode.ai). It installs as **one local plugin** but composes every provider and coordinator in a single package:

1. **CortexKit OpenAI / ChatGPT OAuth** (ChatGPT Plus/Pro native) — multi-account, main/order, routing.
2. **Google Antigravity OAuth** — multi-account Gemini/Claude access.
3. **ChatGPT Web bridge** — loopback provider with reasoning effort slider control, turn isolation, and streaming.
4. **Runtime model fallback** — per-tier `fallback_models` chains across providers on 429 / quota / 5xx.
5. **Delegation router** — real, coherent `fast` / `medium` / `heavy` agents, each with a primary model (+variant) and its own fallback chain.
6. **Resumable setup wizard & migration engine** — scans and imports existing CortexKit, Fallback, and Codex-ChatGPT-Web configs/secrets, replacing legacy plugins to prevent conflicts.
7. **Friendly TUI sidebar** — unified provider + router + wizard summary plus native CortexKit quota and ChatGPT Web turn counters.

---

## Installation & Legacy Migration

### 1. Build from checkout

```bash
cd /path/to/projects/universal-model-manager
npm install
npm run checks
npm test
npm run build
```

### 2. Migration from Legacy Plugins (CortexKit / Fallback / Codex-ChatGPT-Web)

If you have existing `@cortexkit/*`, `opencode-runtime-fallback`, or `codex-chatgpt-web` configurations or sessions:

```bash
# Preview what is detected without making changes:
node dist/cli.js scan

# Interactive migration wizard:
node dist/cli.js migrate
```

The wizard:
- Scans `~/.config/opencode/` for existing OpenAI OAuth accounts, Antigravity tokens, and fallback configurations.
- Scans for live `codex-chatgpt-web` browser session cookies (`storage-state.json`) and imports them directly so you do not need to re-login.
- Replaces legacy plugin registrations in `opencode.jsonc` and `tui.json` with `universal-model-manager`, warning about potential hook collisions if kept active.
- Optionally uninstalls legacy npm packages from `~/.config/opencode`.

### 3. Clean Setup (without migration)

If you prefer a clean setup without scanning:

```bash
node dist/cli.js install --local "$PWD" --backup
```

If you omit `--local`, the installer infers this checkout from its own `import.meta.url`. It asserts the built entrypoints exist and validates existing config as JSONC before writing. Missing configuration files are created; invalid configuration or missing build artifacts abort installation. Quit and restart OpenCode, then run **`/u-setup`**. The running session keeps its old plugin configuration until restart.

`--backup` writes a `<file>.bak` for **both** the server config and `tui.json` before any change, with **unique names that never overwrite an existing `.bak`**, so you can roll back:

```bash
cp ~/.config/opencode/opencode.jsonc.bak ~/.config/opencode/opencode.jsonc
cp ~/.config/opencode/tui.json.bak       ~/.config/opencode/tui.json
```

Writes are atomic (temp file + rename) with `0600` permissions, and parent directories are created for a fresh install. The package registers a single installed package with two **server** entrypoints (the main compose plugin at `dist/index.js` and the antigravity auth at `dist/antigravity/index.js`) plus one **TUI** entry (shipped at `src/tui/entry.mjs`, loaded through the `./tui` export). The installer does **not** write static agent chains — the runtime manager owns the `fast`/`medium`/`heavy` and `build` agents from `manager.json` on every start, preserving your prompts/permissions.

### Uninstall

```bash
cd /absolute/path/to/opencode-universal-auth
node dist/cli.js uninstall --backup
# Restart OpenCode after removing the registrations.
```

The `uninstall` flow removes only the entries this manager owns (its plugin ids, its local `file:` refs, the legacy `opencode-model-router` / CortexKit auth / runtime-fallback names it replaced, and the `chatgpt-web` provider **only if it carries the manager's own signature**). It keeps every other plugin, provider config, and user agent/setting intact — a **user-authored `chatgpt-web` provider is never deleted**.

---

## What the wizard does

The wizard walks three steps — `accounts` → `tiers` → `router`. Completion is **derived from real setting/credential validity**, not an arbitrary "finished" counter:

| Step | Valid when |
|---|---|
| `accounts` | You confirm an authenticated provider, or explicitly skip native authentication to use an external provider such as IIT. |
| `tiers` | You confirm each tier's valid model, variant and ordered fallback settings. Defaults are suggestions, not completed setup. |
| `router` | You confirm the router setting and valid orchestrator model. |

Account readiness is reconciled against the provider stores, separately from your wizard confirmations:

- OpenAI: account configuration and its separate credential state; the OpenCode primary login is distinct from additional accounts.
- Antigravity: `~/.config/opencode/antigravity-accounts.json`
- ChatGPT Web: the saved browser session (`chatgpt-storage-state.json`)

Skipping authentication does not mark any account as authenticated.

Each successful choice is persisted **atomically** to:

```
~/.config/opencode/universal-auth/manager.json
```

On every load the manager recomputes the *first missing valid setting* and resumes exactly there — including after a chat restart. Cancellation simply leaves the already-persisted choices in place.

---

## Slash commands

| Command | Behaviour |
|---|---|
| `/connect-google` | Add a new Google (Antigravity) account via OAuth. |
| `/accounts` | Open provider-account controls and native login/account dialogs (alias `/u-accounts`). |
| `/setup` | Open the interactive setup wizard (alias `/u-setup`). |
| `/fallback-list` | Open the tier settings and ordered fallback editor (alias `/u-fallbacks`). |
| `/reset` | **Reset only the manager config + wizard** to defaults. **Provider credentials are NEVER touched.** (alias `/u-reset`) |
| `/u-status` | Unified provider + router + wizard summary. |
| `/u-migrate` | Apply the manager config migration to the current on-disk version. |
| `/universal-status` | Backwards-compatible alias of `/u-status`. |

> **Scope of `/u-reset`**: after confirmation, it resets manager settings and wizard progress. It does **not** reset provider account ordering or delete provider credentials/browser sessions. Restart OpenCode to apply reset routing settings. The CLI `reset` requires `UNIVERSAL_AUTH_CONFIRM_RESET=1`.

---

## CLI

From the checkout, use `node dist/cli.js <command>`. The executable aliases below are also available when the package has been installed into your executable path.

| Command | Description |
|---|---|
| `universal-model-manager status` | Provider + manager + wizard status |
| `universal-model-manager wizard` | Current missing step |
| `universal-model-manager accounts` / `accounts add <openai\|antigravity\|chatgpt-web> [label]` / `accounts reorder <id...>` / `accounts main <id>` | Manage accounts, main and order |
| `universal-model-manager router set <fast\|medium\|heavy> <model> [variant] [fallback,...]` | Set a tier chain |
| `universal-model-manager reset` | Reset manager config + wizard (confirmation-gated) |
| `universal-model-manager migrate` | Apply config migration |
| `universal-model-manager install [--backup] [--local <path>]` / `setup` | Write plugin + tui + managed chatgpt-web entries (`--local` = this checkout; inferred from `import.meta.url` when omitted) |
| `universal-model-manager login chatgpt-web` | Launch Chrome for ChatGPT login |
| `universal-model-manager bridge [--port <n>]` | Run the ChatGPT bridge daemon |

All commands honour `OPENCODE_CONFIG_DIR` and `OPENCODE_UNIVERSAL_AUTH_DIR` for isolated/CI use. The manager never writes credentials into `manager.json` (secrets stay in the provider-specific auth stores owned by CortexKit/Antigravity).

---

## Router & fallback chains

The delegation router uses a **flat** agent model: `fast`/`medium`/`heavy` subagents plus the `build` orchestrator, each with a primary model (+variant) and an ordered `fallback_models` chain. The installer does **not** write static agent snapshots — the runtime manager owns these agents and re-applies them on every start from `manager.json` through its own original tier-routing `config` hook, so routing always reflects the saved settings even if the config was hand-edited. There is no linked external router; the tier-routing protocol is implemented directly by this package.

```jsonc
{
  "agent": {
    "fast":   { "model": "iit/deepseek-v4-flash", "mode": "subagent", "fallback_models": ["google/antigravity-gemini-3.8-flash"] },
    "medium": { "model": "openai/gpt-6-astra", "variant": "medium", "mode": "subagent", "fallback_models": ["google/antigravity-gemini-3.8-flash", "iit/deepseek-v4-flash"] },
    "heavy":  { "model": "openai/gpt-6-astra", "variant": "medium", "mode": "subagent", "fallback_models": ["google/antigravity-gemini-3.8-flash", "iit/deepseek-v4-flash"] },
    "build":  { "model": "iit/deepseek-v4-flash", "description": "Primary orchestrator" }
  }
}
```

Each tier gets its own **real** primary model + fallback chain, so runtime fallback is per-tier. Adjust any tier with `/u-router` or `universal-model-manager router set`. The installer exposes an optional agent write (flat map only, never the old nested `model`/`agent` object form) for explicit opt-in; by default user agent configs are left untouched.

**Variants.** A tier carries a primary `variant` (e.g. `openai/gpt-6-astra` at `medium`) and can give **individual fallbacks their own variant** without making DeepSeek carry one: the manager stores an optional `fallbackVariants` map (`{ "google/antigravity-gemini-3.8-flash": "medium" }`) keyed by model id, exposed as ordered `tierTargets()`. This is backwards compatible with a bare string `fallback` list and an explicit `targets: [{model, variant?}]` array.

**Restart override.** On every restart the composed plugin `config` hook re-registers the `fast`/`medium`/`heavy` agents (models, variants, `fallback_models`) and the `build` orchestrator from `manager.json` — so manager-selected routing always wins, even if the installed agents were hand-edited. If routing is `disabled` in `manager.json`, the tier registration does not run. `/u-reset` restores defaults and they are re-applied on the next restart.

---

## TUI sidebar

The TUI registers:
- The **native CortexKit OpenAI and Antigravity widgets** (account dialogs, quota/credits) — reused, not reinvented.
- A **Model Manager** sidebar summary of provider readiness and wizard state.
- A graphical setup wizard driven by the host dialog APIs. It walks provider accounts → per-tier model/variant/fallback selectors → router enable/disable + orchestrator, persisting successful choices.
- Settings dialogs for provider accounts/routing preferences, model chains, and confirmed manager-settings reset. Adding an OpenAI fallback account does not replace the host's primary login.
- Command-palette entries wired via `api.command.register` to those dialogs.

The TUI entrypoint ships at the package `./tui` export and loads the compiled `dist/tui.js`.

---

## Development

```bash
npm install          # in the repo checkout
npm run checks       # strict typecheck (tsconfig.json, src + tests)
npm test             # vitest, isolated temp configs only
npm run build        # tsc to dist/ with hard failure (no `|| true` masking)

# Exercise the built CLI directly (same args as the installed alias):
node dist/cli.js status
node dist/cli.js install --local "$PWD" --backup
node dist/cli.js router set medium openai/gpt-6-astra medium google/antigravity-gemini-3.8-flash,iit/deepseek-v4-flash
node dist/cli.js uninstall --backup
```

Tests cover: manager persistence/resume/reset, **real credential-derived** provider readiness, validity-derived wizard steps, the **TUI wizard-core API contract** (resume ordering, tier/variant selectors), real account/router command actions, config/agent chains, full hook composition (no provider/hook dropped), entrypoint/loading, invalid input + migration, and config-writer idempotency. Integration tests use `OPENCODE_UNIVERSAL_AUTH_DIR` / `OPENCODE_CONFIG_DIR` pointed at temp dirs — the live `~/.config` is never touched.

> **ChatGPT Web limitation:** the browser bridge currently supports one saved browser login. Multiple ChatGPT/OpenAI OAuth accounts are supported through CortexKit, but multiple isolated ChatGPT Web browser sessions are not implemented.

---

## License

MIT (see [LICENSE](LICENSE)).

This package composes and depends on:
- `@cortexkit/opencode-openai-auth` and `@cortexkit/opencode-antigravity-auth` (CortexKit auth/account/credit providers) — MIT sources reused by composition.
- `opencode-runtime-fallback` (runtime model replay).

The delegation router is implemented **natively** in this MIT source tree (an original flat-map tier-routing protocol); no GPL code is copied and no `opencode-model-router` dependency remains. The installer only *removes* the old `opencode-model-router` / CortexKit / runtime-fallback registrations from your config; it never `npm uninstalls` the auth packages (they remain as transitive dependencies of the new package).
