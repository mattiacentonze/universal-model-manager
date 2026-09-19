# Universal Model Manager (UMM) — AGENTS.md

## Project overview

UMM is a single unified OpenCode plugin that composes all model providers and coordinators into one package: CortexKit OpenAI/ChatGPT OAuth, Google Antigravity OAuth, ChatGPT Web bridge, runtime fallback, delegation router, resumable setup wizard, and a unified TUI sidebar. It is self-contained (vendors CortexKit auth and the fallback engine) and does not depend on other OpenCode plugins at runtime.

## Commands

- Build: `npm run build` (tsc + TUI build + vendor copy)
- Typecheck: `npm run typecheck` (tsc --noEmit)
- Checks: `npm run checks`
- Test: `npm run test` (vitest run)
- Test clicks: `npm run test:clicks`
- Lint: `npm run lint` (biome check .)
- Format: `npm run format` (biome format --write .)

## Version Bumping / Incremento Versione

Quando lo ritieni opportuno, aumenta la versione del package. Cambia i numeri medi o a destra (patch/minor), non il major: es. `0.1.0 -> 0.1.1` (patch, bugfix/minor fix) oppure `0.2.0` (minor, nuova feature). Aggiorna `version` in `package.json`. Non incrementare il major senza esplicita richiesta.
