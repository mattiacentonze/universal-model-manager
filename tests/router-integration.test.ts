import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countRealAccounts, providerConfigured, reconcileConfigured } from "../src/manager/auth-status.js";
import { emptyConfig } from "../src/manager/store.js";
import { handleManagerCommand, summarize, ensureSingleMain } from "../src/manager/commands.js";
import { remainingSteps, tierVariantOptions, missingTiers } from "../src/tui/wizard-core.js";

function fakeConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "uaconf-"));
}

function fakeDataDir(): string {
  return mkdtempSync(join(tmpdir(), "uadata-"));
}

describe("Real underlying provider auth status", () => {
  it("reports not configured when stores are absent", () => {
    const dir = fakeConfigDir();
    expect(providerConfigured("openai", dir)).toBe(false);
    expect(providerConfigured("antigravity", dir)).toBe(false);
    expect(countRealAccounts("openai", dir)).toBe(0);
  });

  it("derives configured from real credentialed accounts in the CortexKit stores", () => {
    const dir = fakeConfigDir();
    writeFileSync(join(dir, "openai-auth.json"), JSON.stringify({ version: 1, main: { type: "opencode", provider: "openai" }, mainAccountId: "x", accounts: [{ id: "x", accountId: "x", type: "oauth", enabled: true }] }));
    // Credentials live in the separate state store, NOT in the config file.
    writeFileSync(join(dir, "openai-auth-state.json"), JSON.stringify({ version: 1, accounts: { x: { refresh: "rt", expires: 4_100_000_000_000 } } }));
    expect(providerConfigured("openai", dir)).toBe(true);
    expect(countRealAccounts("openai", dir)).toBe(1);
    // Missing antigravity store remains unconfigured.
    expect(providerConfigured("antigravity", dir)).toBe(false);
  });

  it("ignores non-oauth / disabled accounts when deriving readiness", () => {
    const dir = fakeConfigDir();
    writeFileSync(
      join(dir, "openai-auth.json"),
      JSON.stringify({ version: 1, main: { type: "opencode", provider: "openai" }, accounts: [
        { id: "api", type: "api", baseURL: "https://x", apiKey: "k" },
        { id: "off", type: "oauth", enabled: false },
      ] })
    );
    // No credential store, and the only oauth account is disabled.
    expect(countRealAccounts("openai", dir)).toBe(0);
  });

  it("reconcileConfigured mirrors real status onto manager entries", () => {
    const dir = fakeConfigDir();
    writeFileSync(join(dir, "antigravity-accounts.json"), JSON.stringify({ version: 4, activeIndex: 0, accounts: [{ email: "g@x", refreshToken: "rt", addedAt: 1, lastUsed: 1, enabled: true }] }));
    const cfg = emptyConfig();
    const out = reconcileConfigured(cfg.accounts, dir);
    expect(out.find(a => a.kind === "openai")).toBeUndefined(); // no real openai account
    expect(out.find(a => a.kind === "antigravity")?.configured).toBe(true);
  });
});

describe("Command handler: real account & router actions", () => {
  it("/u-accounts add returns a native login action (never fakes configured)", async () => {
    const cfgDir = fakeConfigDir();
    const res = await handleManagerCommand("u-accounts", "add openai MyAccount", fakeDataDir(), cfgDir);
    expect(res?.action?.kind).toBe("login");
    expect(res?.action?.command).toBe("/openai-account");
    expect(res?.action?.cli).toEqual({ command: "openai-auth", args: ["login"] });
  });

  it("/u-router tier sets model, variant and fallback chain", async () => {
    const cfgDir = fakeConfigDir();
    const res = await handleManagerCommand("u-router", "tier medium openai/gpt-6-astra high google/antigravity-gemini-3.8-flash,iit/deepseek-v4-flash", fakeDataDir(), cfgDir);
    expect(res?.text).toContain("medium chain set to openai/gpt-6-astra");
  });

  it("/u-setup reports explicit provider setup state", async () => {
    const cfgDir = fakeConfigDir();
    const res = await handleManagerCommand("u-setup", "", fakeDataDir(), cfgDir);
    expect(res?.text).toContain("OpenAI: pending");
    expect(res?.text).toContain("Antigravity: pending");
  });

  it("ensureSingleMain keeps exactly one main per provider", () => {
    const cfg = emptyConfig();
    const mixed = cfg.accounts.map(a => ({ ...a, main: true }));
    const out = ensureSingleMain(mixed);
    expect(out.filter(a => a.kind === "openai" && a.main)).toHaveLength(1);
    expect(out.filter(a => a.kind === "antigravity" && a.main)).toHaveLength(1);
  });
});

describe("TUI wizard core (API contract)", () => {
  it("remainingSteps resumes from accounts: fresh defaults are not confirmed", () => {
    const cfg = emptyConfig();
    const cfgDir = fakeConfigDir();
    // Defaults pre-fill every tier + orchestrator, but nothing is user-confirmed,
    // so all three steps are genuinely missing (defaults are suggestions only).
    expect(remainingSteps(cfg, cfgDir)).toEqual(["accounts", "tiers", "router"]);
  });

  it("remainingSteps is empty only when every step is confirmed and valid", () => {
    const cfgDir = fakeConfigDir();
    writeFileSync(join(cfgDir, "antigravity-accounts.json"), JSON.stringify({ version: 4, activeIndex: 0, accounts: [{ email: "g@x", refreshToken: "rt", addedAt: 1, lastUsed: 1, enabled: true }] }));
    const cfg = emptyConfig();
    // Confirm accounts via skip-auth (external provider, no local creds needed),
    // confirm each tier and the router, then nothing is missing.
    cfg.wizard = {
      completed: ["accounts", "tiers", "router"],
      updatedAt: "now",
      accountsConfirmed: true,
      accountsSkipAuth: true,
      tiersConfirmed: { fast: true, medium: true, heavy: true },
      routerConfirmed: true,
    };
    expect(remainingSteps(cfg, cfgDir)).toEqual([]);
    expect(remainingSteps(cfg, cfgDir)).toHaveLength(0);
  });

  it("unconfirmed defaults still leave tiers and router missing after accounts", () => {
    const cfg = emptyConfig();
    const cfgDir = fakeConfigDir();
    cfg.wizard = { completed: ["accounts"], updatedAt: "now", accountsConfirmed: true, accountsSkipAuth: true };
    // Even though default tier models + orchestrator are non-empty, they are not
    // user-confirmed, so tiers and router remain missing.
    expect(remainingSteps(cfg, cfgDir)).toEqual(["tiers", "router"]);
  });

  it("missingTiers reports only tiers without confirmation or a model", () => {
    const cfg = emptyConfig();
    cfg.router.tiers.heavy.model = "";
    expect(missingTiers(cfg)).toEqual(["fast", "medium", "heavy"]);
    cfg.router.tiers.heavy.model = "openai/gpt-6-astra";
    cfg.wizard = { completed: [], updatedAt: "now", tiersConfirmed: { fast: true, medium: true, heavy: true } };
    expect(missingTiers(cfg)).toEqual([]);
  });

  it("tierVariantOptions offers default first, then only catalog-known variants", () => {
    const opts = tierVariantOptions("openai/gpt-6-astra", ["medium", "high"]);
    expect(opts[0].value).toBeUndefined();
    expect(opts.map(o => o.value)).toContain("medium");
    expect(opts.map(o => o.value)).toContain("high");
  });

  it("summarize renders real configured status", () => {
    const cfgDir = fakeConfigDir();
    const cfg = emptyConfig();
    const s = summarize(cfg, cfgDir);
    expect(s).toContain("pending");
  });
});
