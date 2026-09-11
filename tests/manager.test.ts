import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completeStep,
  currentStep,
  emptyConfig,
  firstMissingStep,
  isWizardComplete,
  loadConfig,
  migrateConfig,
  resetManager,
  saveConfig,
  validateConfig,
  buildAgentConfig,
  applyTierPatch,
  setTierTargets,
  tierTargets,
  isValidModelId,
} from "../src/manager/index.js";
import { fakeConfigDir, writeProviderCreds } from "./helpers.js";

function confirmAllWizard(cfg: ReturnType<typeof emptyConfig>): ReturnType<typeof emptyConfig> {
  cfg.wizard = {
    completed: ["accounts", "tiers", "router"],
    updatedAt: "now",
    accountsConfirmed: true,
    accountsSkipAuth: true,
    tiersConfirmed: { fast: true, medium: true, heavy: true },
    routerConfirmed: true,
  };
  return cfg;
}

describe("Manager persistence & confirmation-driven wizard", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uamm-"));
    process.env.OPENCODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "uaconf-"));
  });
  afterEach(() => {
    // no cleanup needed for tmpdir fixtures
  });

  it("creates a valid default config when none exists and resumes at accounts", () => {
    const cfg = loadConfig(dir);
    expect(cfg.version).toBe(1);
    expect(cfg.accounts.length).toBeGreaterThan(0);
    expect(cfg.router.tiers.fast.model).toBeTruthy();
    // Defaults are suggestions, not assertions: fresh wizard must show accounts.
    expect(firstMissingStep(cfg)).toBe("accounts");
    expect(currentStep(dir)).toBe("accounts");
  });

  it("fresh wizard must show accounts/tiers/router, never complete on non-empty defaults", () => {
    const cfg = emptyConfig();
    // All defaults are non-empty, yet nothing is confirmed -> every step missing.
    expect(isWizardComplete(cfg)).toBe(false);
    expect(firstMissingStep(cfg)).toBe("accounts");
    expect(currentStep(dir)).toBe("accounts");
  });

  it("accounts step completes with any real provider OR explicit skip-auth, not both", () => {
    // Skip-auth path: confirm accounts with NO real provider.
    const cfg = emptyConfig();
    const r1 = completeStep("accounts", { accounts: cfg.accounts, accountsSkipAuth: true }, dir);
    expect(firstMissingStep(r1.cfg)).toBe("tiers");

    // Real-provider path: confirm accounts with one real credentialed provider.
    writeProviderCreds(fakeConfigDir(), ["antigravity"]);
    const r2 = completeStep("accounts", { accounts: cfg.accounts }, dir);
    expect(firstMissingStep(r2.cfg)).toBe("tiers");
  });

  it("tiers require each of fast/medium/heavy confirmed and valid (no default skip)", () => {
    completeStep("accounts", { accounts: emptyConfig().accounts, accountsSkipAuth: true }, dir);
    // Confirm only one tier -> tiers still the next step.
    completeStep("tiers", { fast: { model: "iit/deepseek-v4-flash" } }, dir);
    expect(firstMissingStep(loadConfig(dir))).toBe("tiers");
    // Confirm the remaining tiers -> router becomes next.
    completeStep("tiers", { medium: { model: "openai/gpt-6-astra", variant: "medium" }, heavy: { model: "openai/gpt-6-astra", variant: "medium" } }, dir);
    expect(firstMissingStep(loadConfig(dir))).toBe("router");
  });

  it("router requires orchestrator confirmation", () => {
    completeStep("accounts", { accounts: emptyConfig().accounts, accountsSkipAuth: true }, dir);
    completeStep("tiers", { fast: { model: "iit/deepseek-v4-flash" }, medium: { model: "openai/gpt-6-astra" }, heavy: { model: "openai/gpt-6-astra" } }, dir);
    expect(firstMissingStep(loadConfig(dir))).toBe("router");
    completeStep("router", { orchestrator: "iit/deepseek-v4-flash", enabled: true }, dir);
    expect(isWizardComplete(loadConfig(dir))).toBe(true);
    expect(currentStep(dir)).toBeNull();
  });

  it("round-trips a saved config atomically", () => {
    writeProviderCreds(fakeConfigDir(), ["openai", "antigravity"]);
    const cfg = confirmAllWizard(emptyConfig());
    saveConfig(cfg, dir);
    const loaded = loadConfig(dir);
    expect(isWizardComplete(loaded)).toBe(true);
    expect(loaded.router.tiers.medium.model).toBe("openai/gpt-6-astra");
  });

  it("does not persist secrets in the stored config", () => {
    const cfg = emptyConfig();
    saveConfig(cfg, dir);
    const raw = readFileSync(join(dir, "manager.json"), "utf8");
    expect(raw).not.toMatch(/access|refresh|token|apiKey|cookie/i);
  });

  it("cancellation/interruption retains prior progress and resumes the next substep", () => {
    // Complete only a partial chain for heavy (model saved) before interruption.
    completeStep("accounts", { accounts: emptyConfig().accounts, accountsSkipAuth: true }, dir);
    completeStep("tiers", { heavy: { model: "openai/gpt-6-astra" } }, dir);
    const reloaded = loadConfig(dir);
    // heavy is confirmed, fast/medium not -> tiers still missing.
    expect(reloaded.wizard?.tiersConfirmed?.heavy).toBe(true);
    expect(firstMissingStep(reloaded)).toBe("tiers");
  });

  it("REGRESSION: skip-auth persists so a SAME-SESSION reopen resumes FAST, not accounts", () => {
    // Reproduce the reported defect: skip native auth, then reopen (reload from
    // disk) without logging in. The wizard must resume at FAST, never accounts.
    const cfg = loadConfig(dir);
    completeStep("accounts", { accounts: cfg.accounts, accountsSkipAuth: true }, dir);
    // Fresh load = a newly re-rendered wizard reading state back from disk.
    const fresh = loadConfig(dir);
    expect(fresh.wizard?.accountsSkipAuth).toBe(true);
    expect(fresh.wizard?.accountsConfirmed).toBe(true);
    expect(firstMissingStep(fresh)).toBe("tiers");
    expect(currentStep(dir)).toBe("tiers");
  });

  it("REGRESSION: skip-auth persists across a FULL RESTART (new loadConfig) to FAST", () => {
    completeStep("accounts", { accounts: emptyConfig().accounts, accountsSkipAuth: true }, dir);
    // Simulate process restart: a brand-new load from the persisted file row.
    const restarted = loadConfig(dir);
    expect(restarted.wizard?.accountsSkipAuth).toBe(true);
    expect(firstMissingStep(restarted)).toBe("tiers");
    // Confirming one tier (the default suggestion) must NOT mark the others done.
    completeStep("tiers", { fast: { model: restarted.router.tiers.fast.model } }, dir);
    const afterFast = loadConfig(dir);
    expect(afterFast.wizard?.tiersConfirmed?.fast).toBe(true);
    expect(afterFast.wizard?.tiersConfirmed?.medium).toBeUndefined();
    expect(firstMissingStep(afterFast)).toBe("tiers");
  });

  it("reset restores defaults, clears wizard, keeps credentials; resumes at accounts", () => {
    writeProviderCreds(fakeConfigDir(), ["openai", "antigravity"]);
    const cfg = confirmAllWizard(emptyConfig());
    saveConfig(cfg, dir);
    expect(isWizardComplete(loadConfig(dir))).toBe(true);
    const reset = resetManager(dir);
    expect(reset.wizard).toBeNull();
    // Credentials persist beneath, but wizard progress was cleared -> resume at accounts.
    expect(firstMissingStep(reset)).toBe("accounts");
    expect(loadConfig(dir).wizard).toBeNull();
  });
});

describe("Manager validation & strict file handling", () => {
  it("loadConfig throws on a corrupt file instead of silently wiping", () => {
    const dir = mkdtempSync(join(tmpdir(), "uamv-"));
    writeFileSync(join(dir, "manager.json"), "not json{");
    expect(() => loadConfig(dir)).toThrow();
  });

  it("loadConfig throws on an unknown config version", () => {
    const dir = mkdtempSync(join(tmpdir(), "uamvu-"));
    writeFileSync(join(dir, "manager.json"), JSON.stringify({ version: 99, accounts: [], router: { orchestrator: "a/b", enabled: true, tiers: { fast: { model: "a/b", fallback: [] }, medium: { model: "a/b", fallback: [] }, heavy: { model: "a/b", fallback: [] } } }, wizard: null }));
    expect(() => loadConfig(dir)).toThrow(/version/);
  });

  it("saveConfig refuses to write invalid/unknown-version config", () => {
    const dir = mkdtempSync(join(tmpdir(), "uams-"));
    const bad = { ...emptyConfig(), version: 42 };
    expect(() => saveConfig(bad as never, dir)).toThrow(/version/);
  });

  it("validateConfig rejects structurally invalid router", () => {
    expect(() => validateConfig({ version: 1, accounts: [], router: "nope", wizard: null })).toThrow(/router/);
  });

  it("validateConfig preserves exactly one main per provider", () => {
    const cfg = emptyConfig();
    const v = validateConfig({ ...cfg, accounts: cfg.accounts.map(a => ({ ...a, main: true })) });
    expect(v.accounts.filter(a => a.kind === "openai" && a.main)).toHaveLength(1);
    expect(v.accounts.filter(a => a.kind === "antigravity" && a.main)).toHaveLength(1);
  });

  it("migrates a legacy pre-manager file to the current version", () => {
    const dir = mkdtempSync(join(tmpdir(), "uammig-"));
    writeFileSync(join(dir, "manager.json"), JSON.stringify({ version: 0, accounts: [{ id: "a", kind: "openai", label: "A", main: false, configured: false }], router: { orchestrator: "a/b", enabled: true, tiers: { fast: { model: "a/b", fallback: [] }, medium: { model: "a/b", fallback: [] }, heavy: { model: "a/b", fallback: [] } } }, wizard: null }));
    const cfg = migrateConfig(dir);
    expect(cfg.version).toBe(1);
  });
});

describe("Tier chain schema validation & canonical targets", () => {
  it("isValidModelId requires provider/model", () => {
    expect(isValidModelId("openai/gpt-4o")).toBe(true);
    expect(isValidModelId("bare-model")).toBe(false);
    expect(isValidModelId("")).toBe(false);
  });

  it("validateConfig rejects duplicate fallback and primary-cycle chains", () => {
    const cfg = emptyConfig();
    const dup = structuredClone(cfg.router);
    dup.tiers.fast.fallback = ["google/antigravity-gemini-3.8-flash", "google/antigravity-gemini-3.8-flash"];
    expect(() => validateConfig({ ...cfg, router: dup })).toThrow();

    const cycle = structuredClone(cfg.router);
    cycle.tiers.fast.fallback = ["iit/deepseek-v4-flash"]; // same as primary -> cycle
    expect(() => validateConfig({ ...cfg, router: cycle })).toThrow();
  });

  it("validateConfig rejects fallbackVariants keyed to a non-target model", () => {
    const cfg = emptyConfig();
    const bad = structuredClone(cfg.router);
    bad.tiers.fast.fallbackVariants = { "openai/gpt-6-astra": "medium" }; // not in fallback
    expect(() => validateConfig({ ...cfg, router: bad })).toThrow();
  });

  it("setTierTargets/persistChan keeps targets, fallback and fallbackVariants consistent", () => {
    const cfg = emptyConfig();
    const chain = cfg.router.tiers.medium;
    const updated = setTierTargets(chain, [
      { model: "google/antigravity-gemini-3.8-flash", variant: "medium" },
      { model: "iit/deepseek-v4-flash" },
    ]);
    expect(updated.targets).toHaveLength(2);
    expect(updated.fallback).toEqual(["google/antigravity-gemini-3.8-flash", "iit/deepseek-v4-flash"]);
    expect(updated.fallbackVariants).toEqual({ "google/antigravity-gemini-3.8-flash": "medium" });
    expect(tierTargets(updated)).toEqual([
      { model: "google/antigravity-gemini-3.8-flash", variant: "medium" },
      { model: "iit/deepseek-v4-flash", variant: undefined },
    ]);
    // The edited chain must survive a validate round-trip.
    const next = applyTierPatch(cfg.router, { medium: updated });
    expect(() => validateConfig({ ...cfg, router: next })).not.toThrow();
  });

  it("applyTierPatch updates only the given tier", () => {
    const cfg = emptyConfig();
    const next = applyTierPatch(cfg.router, { fast: { model: "a/b", fallback: ["c/d"] } });
    expect(next.tiers.fast.model).toBe("a/b");
    expect(next.tiers.medium.model).toBe(cfg.router.tiers.medium.model);
  });

  it("builds a flat agent map with valid model strings and fallback chains", () => {
    const cfg = emptyConfig();
    const agent = buildAgentConfig(cfg.router);
    expect(Object.keys(agent ?? {}).sort()).toEqual(["build", "fast", "heavy", "medium"]);
    expect(typeof agent.build!.model).toBe("string");
    expect(agent.build!.model).toBe(cfg.router.orchestrator);
    expect(agent.fast!.model).toBe(cfg.router.tiers.fast.model);
    expect(agent.medium!.variant).toBe("medium");
    expect(agent.medium!.mode).toBe("subagent");
    expect(agent.heavy!.fallback_models).toEqual(tierTargets(cfg.router.tiers.heavy).map(t => t.model));
    expect(agent.build!.fallback_models).toContain(cfg.router.tiers.heavy.model);
  });
});
