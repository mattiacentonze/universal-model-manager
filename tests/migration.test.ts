import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  detectLegacyPluginsAndConfigs,
  formatDiscoveryReport,
  executeMigration,
} from "../src/migration/index.js";

describe("Migration Engine", () => {
  it("detects legacy cortexkit, fallback, and codex-chatgpt-web configurations", () => {
    const tempConfigDir = join(tmpdir(), `test-opencode-cfg-${Date.now()}`);
    const tempHome = join(tmpdir(), `test-opencode-home-${Date.now()}`);
    mkdirSync(tempConfigDir, { recursive: true });
    mkdirSync(tempHome, { recursive: true });

    // 1. Create dummy opencode.jsonc with legacy plugins
    writeFileSync(
      join(tempConfigDir, "opencode.jsonc"),
      JSON.stringify({
        plugin: [
          "@cortexkit/opencode-openai-auth",
          "@cortexkit/opencode-antigravity-auth",
          "opencode-runtime-fallback",
        ],
      })
    );

    // 2. Create dummy openai-auth.json and state
    writeFileSync(
      join(tempConfigDir, "openai-auth.json"),
      JSON.stringify({ mainAccountId: "test-openai-id", accounts: [{ id: "test" }] })
    );
    writeFileSync(
      join(tempConfigDir, "openai-auth-state.json"),
      JSON.stringify({ access_token: "secret-token" })
    );

    // 3. Create dummy antigravity-accounts.json
    writeFileSync(
      join(tempConfigDir, "antigravity-accounts.json"),
      JSON.stringify([{ email: "test@google.com", refresh_token: "google-secret" }])
    );

    // 4. Create dummy codex-chatgpt-web storage-state
    const codexWebDir = join(tempHome, ".codex-chatgpt-web");
    mkdirSync(codexWebDir, { recursive: true });
    writeFileSync(
      join(codexWebDir, "storage-state.json"),
      JSON.stringify({ cookies: [{ name: "session", value: "chatgpt-cookie", domain: "chatgpt.com" }] })
    );

    const report = detectLegacyPluginsAndConfigs({
      configDir: tempConfigDir,
      homeDir: tempHome,
    });

    expect(report.items.length).toBe(4);
    expect(report.hasConflictsWithUniversalManager).toBe(true);
    expect(report.conflictSummary.length).toBe(3);

    const itemIds = report.items.map(i => i.id);
    expect(itemIds).toContain("cortexkit-openai");
    expect(itemIds).toContain("cortexkit-antigravity");
    expect(itemIds).toContain("runtime-fallback");
    expect(itemIds).toContain("codex-chatgpt-web");

    const formatted = formatDiscoveryReport(report);
    expect(formatted).toContain("POTENTIAL CONFLICT WARNING");
    expect(formatted).toContain("CortexKit OpenAI Auth");
    expect(formatted).toContain("Codex ChatGPT Web");

    // Execute migration
    const result = executeMigration(
      report,
      {
        importOpenAi: true,
        importAntigravity: true,
        importFallback: true,
        importChatGptWeb: true,
        replaceInOpenCodeConfig: false,
        replaceInTuiConfig: false,
        uninstallLegacyNpmPackages: false,
      },
      { configDir: tempConfigDir, homeDir: tempHome }
    );

    expect(result.success).toBe(true);
    expect(result.importedItems.length).toBeGreaterThan(0);

    rmSync(tempConfigDir, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });
});
