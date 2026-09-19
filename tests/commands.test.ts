import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { completeStep, handleManagerCommand, isWizardComplete, loadConfig, summarize } from "../src/manager/index.js";
import { emptyConfig } from "../src/manager/store.js";
import { fakeConfigDir, writeProviderCreds } from "./helpers.js";

describe("Manager slash-command handler", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uacmd-"));
    process.env.OPENCODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "uacconf-"));
  });

  it("u-reset resets manager config and wizard while keeping credentials", async () => {
    // Provide real credential stores so the wizard can reach a complete state.
    writeProviderCreds(fakeConfigDir(), ["openai", "antigravity"]);
    // Reach a complete state first.
    const cfg = emptyConfig();
    completeStep(
      "accounts",
      {
        accounts: [
          { ...cfg.accounts[0], configured: true },
          { ...cfg.accounts[1], configured: true },
        ],
      },
      dir,
    );
    completeStep(
      "tiers",
      {
        fast: { model: cfg.router.tiers.fast.model },
        medium: { model: cfg.router.tiers.medium.model },
        heavy: { model: cfg.router.tiers.heavy.model },
      },
      dir,
    );
    completeStep("router", { orchestrator: cfg.router.orchestrator }, dir);
    expect(isWizardComplete(loadConfig(dir))).toBe(true);

    const res = await handleManagerCommand("u-reset", "", dir);
    expect(res?.text).toContain("reset");
    const after = loadConfig(dir);
    expect(after.wizard).toBeNull();
    // Credentials persist across reset; `configured` is re-derived from the real
    // underlying stores, so it stays true. Only wizard/completed state is cleared.
    expect(after.accounts[0].configured).toBe(true);
    expect(after.router.orchestrator).toBeTruthy(); // defaults restored
  });

  it("u-wizard / u-status report the missing step dynamically after partial progress", async () => {
    const cfg = emptyConfig();
    completeStep("accounts", { accounts: [{ ...cfg.accounts[0], configured: true }, cfg.accounts[1]] }, dir);
    expect((await handleManagerCommand("u-wizard", "", dir))?.text).toContain("accounts");
  });

  it("summarize renders accounts, per-tier chains and wizard state", () => {
    const cfg = emptyConfig();
    cfg.accounts[0].configured = true;
    cfg.accounts[1].configured = true;
    const s = summarize(cfg);
    expect(s).toContain("openai");
    expect(s).toContain("antigravity");
    expect(s).toContain("medium");
    expect(s).toContain("accounts");
  });

  it("unknown manager commands return null (delegated to other hooks)", async () => {
    expect(await handleManagerCommand("some-other-command", "", dir)).toBeNull();
  });
});
