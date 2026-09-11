import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openWizard, accountsSettings, routerSettings, showReset } from "../src/tui/dialogs.js";
import tuiDefault from "../src/tui.js";
import { loadConfig, saveConfig } from "../src/manager/index.js";
import { writeProviderCreds } from "./helpers.js";
import { nextMissingStep } from "../src/tui/wizard-core.js";

type DialogOpt = { title?: string; value: string; onSelect?: () => void; description?: string };
type AnyDialog = {
  title?: string;
  options?: DialogOpt[];
  onConfirm?: (v: string) => void;
  onCancel?: () => void;
  message?: string;
};

interface Harness {
  api: Record<string, unknown>;
  command: ReturnType<typeof vi.fn>;
  last: () => AnyDialog | null;
  find: (value: string) => DialogOpt | undefined;
  setRoute: (cur: unknown) => void;
}

function makeApi(): Harness {
  let last: AnyDialog | null = null;
  let routeCurrent: unknown = { name: "home" };
  const command = vi.fn(async () => ({}));
  const setState = (render: () => unknown) => { last = render() as AnyDialog; };
  const api = {
    route: {
      get current() { return routeCurrent; },
      register: vi.fn(),
      navigate: vi.fn(),
    },
    client: { session: { command }, tui: {} },
    state: { provider: [] as never[] },
    slots: { register: vi.fn() },
    ui: {
      dialog: { replace: setState, clear: () => { last = null; }, setSize: vi.fn(), size: "medium", depth: 1, open: true },
      DialogSelect: (p: AnyDialog) => { last = p; return p; },
      DialogPrompt: (p: AnyDialog) => { last = p; return p; },
      DialogConfirm: (p: AnyDialog) => { last = p; return p; },
      DialogAlert: (p: AnyDialog) => { last = p; return p; },
      toast: vi.fn(),
    },
  };
  return {
    api,
    command,
    last: () => last,
    find: (value: string) => last?.options?.find(o => o.value === value),
    setRoute: (cur: unknown) => { routeCurrent = cur; },
  };
}

describe("TUI wizard + native dispatch", () => {
  let dataDir: string;
  let cfgDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tuim-"));
    cfgDir = mkdtempSync(join(tmpdir(), "tuic-"));
    process.env.OPENCODE_UNIVERSAL_AUTH_DIR = dataDir;
    process.env.OPENCODE_CONFIG_DIR = cfgDir;
  });

  it("registers slash commands with a proper `slash` property", async () => {
    const h = makeApi();
    let commands: unknown[] = [];
    const api2 = { ...h.api, command: { register: (cb: () => unknown[]) => { commands = cb(); } } };
    await tuiDefault.tui(api2 as never, undefined, undefined as never);
    const slashNames = (commands as Array<{ slash?: { name: string } }>)
      .filter(e => e.slash)
      .map(e => e.slash!.name);
    expect(slashNames).toEqual(expect.arrayContaining(["u-setup", "u-accounts", "u-main", "u-fallbacks", "u-router", "u-reset"]));
  });

  it("/u-setup slash callback opens the Provider accounts wizard dialog, not a toast", async () => {
    const h = makeApi();
    let commands: unknown[] = [];
    const api2 = { ...h.api, command: { register: (cb: () => unknown[]) => { commands = cb(); } } };
    await tuiDefault.tui(api2 as never, undefined, undefined as never);
    const setup = (commands as Array<{ slash?: { name: string }; onSelect: () => void }>)
      .find(e => e.slash?.name === "u-setup");
    expect(setup).toBeTruthy();
    setup!.onSelect();
    expect(h.last()?.title).toContain("Provider accounts");
    expect((h.api.ui as { toast: ReturnType<typeof vi.fn> }).toast).not.toHaveBeenCalled();
  });

  it("black-box: navigating the accounts wizard yields real login options", () => {
    const h = makeApi();
    openWizard(h.api as never);
    // No real accounts -> accounts step is the resume target.
    expect(h.last()?.title).toContain("Provider accounts");
    const login = h.find("login-openai");
    expect(login?.title).toContain("Login to OpenAI");
  });

  it("dispatches native login to a live session via SDK session.command", async () => {
    const h = makeApi();
    h.setRoute({ name: "session", params: { sessionID: "s1" } });
    accountsSettings(h.api as never);
    h.find("login-openai")!.onSelect!();
    await vi.waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith({ sessionID: "s1", command: "openai-account", arguments: "add" });
  });

  it("does not send a session command from the no-session home state", async () => {
    const h = makeApi();
    h.setRoute({ name: "home" });
    accountsSettings(h.api as never);
    h.find("login-openai")!.onSelect!();
    await vi.waitFor(() => expect(h.command).not.toHaveBeenCalled());
  });

  it("OpenAI set-main maps to a native routing preference, not a false primary switch", async () => {
    writeProviderCreds(cfgDir, ["openai"]);
    const h = makeApi();
    h.setRoute({ name: "session", params: { sessionID: "s1" } });
    accountsSettings(h.api as never);
    const mainOpt = h.last()!.options!.find(o => o.value.startsWith("main-"));
    expect(mainOpt).toBeTruthy();
    // The action is truthfully described as routing, never "replaces primary".
    expect(mainOpt!.title).toMatch(/routing/i);
    mainOpt!.onSelect!();
    await vi.waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith(expect.objectContaining({ command: "openai-routing" }));
  });

  it("wizard resumes at the first missing tier without skipping", () => {
    writeProviderCreds(cfgDir, ["antigravity"]);
    const cfg = loadConfig();
    // Accounts confirmed (real antigravity + skip flag); fast/medium confirmed;
    // heavy left unconfirmed -> resume should be "tiers".
    cfg.wizard = {
      completed: [],
      updatedAt: "now",
      accountsConfirmed: true,
      accountsSkipAuth: true,
      tiersConfirmed: { fast: true, medium: true },
    };
    cfg.router.tiers.heavy.model = "";
    expect(nextMissingStep(cfg, cfgDir)).toBe("tiers");
  });

  it("ordered fallback editor persists an added fallback to the manager config", () => {
    writeProviderCreds(cfgDir, ["antigravity"]);
    const cfg = loadConfig();
    cfg.router.tiers.heavy.model = "openai/gpt-6-astra";
    cfg.router.tiers.heavy.variant = "medium";
    const h = makeApi();
    routerSettings(h.api as never);
    h.find("heavy")!.onSelect!();
    h.find("__add")!.onSelect!();
    // In the fallback picker, any non-control option is a real model to add.
    const model = h.last()!.options!.find(o => !o.value.startsWith("__"));
    model!.onSelect!();
    expect(loadConfig().router.tiers.heavy.fallback).toContain(model!.value);
  });

  it("per-target variant editor propagates variants into targets/fallbackVariants", () => {
    writeProviderCreds(cfgDir, ["antigravity"]);
    const cfg = loadConfig();
    // Clean per-test heavy chain: primary ASTRA with no fallbacks yet.
    cfg.router.tiers.heavy = { model: "openai/gpt-6-astra", variant: "medium", fallback: [] };
    saveConfig(cfg, dataDir);
    const h = makeApi();
    // Seed the real catalog: primary (openai) + a distinct fallback (google) with a variant.
    (h.api as { state: { provider: { id: string; models: Record<string, { name?: string; variant?: string }> }[] } }).state.provider = [
      { id: "google", models: { "antigravity-gemini-3.8-flash": { name: "Gemini", variant: "medium" } } },
      { id: "openai", models: { "gpt-6-astra": { name: "Astra", variant: "high" } } },
    ];
    routerSettings(h.api as never);
    h.find("heavy")!.onSelect!();
    h.find("__add")!.onSelect!();
    const g = h.last()!.options!.find(o => o.value === "google/antigravity-gemini-3.8-flash");
    expect(g).toBeTruthy(); // catalog exposes the distinct fallback target with its variant
    g!.onSelect!();
    const loaded = loadConfig().router.tiers.heavy;
    // Variant propagated to canonical targets + legacy fallbackVariants.
    expect(loaded.targets).toContainEqual({ model: "google/antigravity-gemini-3.8-flash", variant: "medium" });
    expect(loaded.fallbackVariants?.["google/antigravity-gemini-3.8-flash"]).toBe("medium");
  });

  it("interruption mid model->variant keeps the last successful model selection", () => {
    writeProviderCreds(cfgDir, ["antigravity"]);
    const cfg = loadConfig();
    // Only heavy is missing (fast/medium confirmed on the default valid models).
    cfg.wizard = { completed: [], updatedAt: "now", accountsConfirmed: true, accountsSkipAuth: true, tiersConfirmed: { fast: true, medium: true } };
    cfg.router.tiers.heavy.model = "";
    saveConfig(cfg, dataDir);
    const h = makeApi();
    openWizard(h.api as never);
    h.find("model")!.onSelect!();
    h.find("openai")!.onSelect!();
    const model = h.last()!.options!.find(o => o.value.startsWith("openai/") && !o.value.startsWith("__"));
    model!.onSelect!();
    // Cancel out of the variant picker -> the model selection is preserved.
    h.find("__cancel")!.onSelect!();
    expect(loadConfig().router.tiers.heavy.model).toBe(model!.value);
  });

  it("reset requires confirmation before clearing config", () => {
    writeProviderCreds(cfgDir, ["antigravity"]);
    const h = makeApi();
    showReset(h.api as never);
    expect(h.last()?.title).toContain("Reset manager config");
  });
});
