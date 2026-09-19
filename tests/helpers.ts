import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Point OPENCODE_CONFIG_DIR at a fresh temp dir and return it. */
export function fakeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "uadir-"));
  process.env.OPENCODE_CONFIG_DIR = dir;
  return dir;
}

/**
 * Write the REAL CortexKit account stores (production shapes):
 *  - OpenAI config `openai-auth.json` carries ONLY `{id,label,type,enabled,accountId}`
 *    (plus the separate `main` block + `mainAccountId`). NO refresh tokens.
 *  - OpenAI credentials live in the SEPARATE state file `openai-auth-state.json`.
 *  - Antigravity v4 pool carries `refreshToken` (the account identity).
 * Nothing here ever leaks a credential to the adapter's returned listing.
 */
export function writeProviderCreds(
  configDir: string,
  providers: Array<"openai" | "antigravity">,
  opts: { openaiMainId?: string; openaiState?: Record<string, { refresh: string; expires?: number }> } = {},
): void {
  for (const p of providers) {
    if (p === "openai") {
      const mainId = opts.openaiMainId ?? "acc-1";
      writeFileSync(
        join(configDir, "openai-auth.json"),
        `${JSON.stringify({
          version: 1,
          main: { type: "opencode", provider: "openai" },
          routing: { mode: "main-first" },
          mainAccountId: mainId,
          accounts: [{ id: mainId, accountId: mainId, type: "oauth", enabled: true }],
        })}\n`,
      );
      writeFileSync(
        join(configDir, "openai-auth-state.json"),
        `${JSON.stringify({
          version: 1,
          accounts: opts.openaiState ?? { [mainId]: { refresh: "rt-main", expires: 4_100_000_000_000 } },
        })}\n`,
      );
    } else {
      writeFileSync(
        join(configDir, "antigravity-accounts.json"),
        `${JSON.stringify({
          version: 4,
          activeIndex: 0,
          activeIndexByFamily: { claude: 0, gemini: 0 },
          accounts: [{ email: "acct@example.com", refreshToken: "rt-token", addedAt: 1, lastUsed: 1, enabled: true }],
        })}\n`,
      );
    }
  }
}
