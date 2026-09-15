import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openWizard, accountsSettings, routerSettings, showReset, openRoutingSelector, UNIFIED_ROUTING_OPTIONS } from "../src/tui/dialogs.js";
import tuiDefault from "../src/tui.js";
import { loadConfig, saveConfig } from "../src/manager/index.js";
import { writeProviderCreds } from "./helpers.js";
import { nextMissingStep, formatCleanModelName } from "../src/tui/wizard-core.js";
import {
  gatherSidebarData,
  toggleManager,
  toggleOpenai,
  toggleAntigravity,
  toggleZen,
  managerCollapsed,
  openaiCollapsed,
  antigravityCollapsed,
  zenCollapsed,
  readPreferences,
  savePreference,
  formatRoutingDisplay,
  ModelManagerSidebar,
} from "../src/tui/sidebar-widget.js";

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
    expect(slashNames).toEqual(expect.arrayContaining(["fallback-list", "accounts", "setup", "reset"]));
  });

  it("/u-setup slash callback opens the Provider accounts wizard dialog, not a toast", async () => {
    const h = makeApi();
    let commands: unknown[] = [];
    const api2 = { ...h.api, command: { register: (cb: () => unknown[]) => { commands = cb(); } } };
    await tuiDefault.tui(api2 as never, undefined, undefined as never);
    const setup = (commands as Array<{ slash?: { name: string; aliases?: string[] }; onSelect: () => void }>)
      .find(e => e.slash?.name === "setup" || e.slash?.aliases?.includes("u-setup"));
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
    const routingOpt = h.find("routing-openai");
    expect(routingOpt).toBeTruthy();
    expect(routingOpt!.title).toMatch(/routing/i);
    routingOpt!.onSelect!();
    const mainFirst = h.find("main-first");
    expect(mainFirst).toBeTruthy();
    mainFirst!.onSelect!();
    const scopeAll = h.find("all");
    expect(scopeAll).toBeTruthy();
    scopeAll!.onSelect!();
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
    // Model picker -> choose the first model
    const model = h.last()!.options!.find(o => !o.value.startsWith("__"));
    model!.onSelect!();
    // If variant picker opened, choose default
    const vOpt = h.last()!.options!.find(o => o.value === "");
    if (vOpt) vOpt.onSelect!();
    // Alias picker -> choose "No alias"
    h.find("__none")!.onSelect!();
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
    // Variant picker -> select medium
    h.find("medium")!.onSelect!();
    // Alias picker -> select No alias
    h.find("__none")!.onSelect!();
    const loaded = loadConfig().router.tiers.heavy;
    // Variant propagated to canonical targets + legacy fallbackVariants.
    expect(loaded.targets).toContainEqual({ model: "google/antigravity-gemini-3.8-flash", variant: "medium" });
    expect(loaded.fallbackVariants?.["google/antigravity-gemini-3.8-flash"]).toBe("medium");
  });

  it("fallback editor persists the selected account alias on the target", () => {
    writeProviderCreds(cfgDir, ["antigravity"]);
    const cfg = loadConfig();
    // Clean heavy chain so the added fallback is a fresh, non-duplicate model.
    cfg.router.tiers.heavy = { model: "openai/gpt-6-astra", variant: "medium", fallback: [] };
    // The reconciled real antigravity account (label "acct@example.com") gets an alias.
    cfg.accounts[0].alias = "work";
    saveConfig(cfg, dataDir);
    const h = makeApi();
    routerSettings(h.api as never);
    h.find("heavy")!.onSelect!();
    h.find("__add")!.onSelect!();
    const model = h.last()!.options!.find(o => !o.value.startsWith("__"));
    model!.onSelect!();
    // If variant picker opened, choose default
    const vOpt = h.last()!.options!.find(o => o.value === "");
    if (vOpt) vOpt.onSelect!();
    // Alias picker -> choose the "work" alias
    h.find("work")!.onSelect!();
    const loaded = loadConfig().router.tiers.heavy;
    expect(loaded.targets).toContainEqual({ alias: "work", model: model!.value });
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

  it("gatherSidebarData honors chatgpt-web existence and user-defined aliases", () => {
    writeProviderCreds(cfgDir, ["antigravity"]);
    const cfg = loadConfig();
    cfg.accounts[0].alias = "work-ag";
    saveConfig(cfg, dataDir);

    // 1. Without chatgpt-web account -> exists is false
    const initial = gatherSidebarData(cfgDir);
    expect(initial.chatgptWeb.exists).toBe(false);
    const agAcct = initial.antigravity.accounts.find(a => a.label === "work-ag" || a.id.includes("antigravity"));
    expect(agAcct).toBeTruthy();

    // 2. With chatgpt-web account -> exists is true and displays alias
    cfg.accounts.push({
      id: "chatgpt-web-1",
      kind: "chatgpt-web",
      label: "ChatGPT Web Session",
      alias: "web-alias",
      main: false,
      configured: true,
    });
    saveConfig(cfg, dataDir);

    const withWeb = gatherSidebarData(cfgDir);
    expect(withWeb.chatgptWeb.exists).toBe(true);
    expect(withWeb.chatgptWeb.alias).toBe("web-alias");
  });

  it("gatherSidebarData exposes the general router routing mode, defaulting to main-first", () => {
    writeProviderCreds(cfgDir, ["antigravity"]);
    const cfg = loadConfig();
    saveConfig(cfg, dataDir);

    // Default: main-first.
    expect(gatherSidebarData(cfgDir).routingMode).toBe("main-first");

    // Custom mode is reflected.
    cfg.router.routingMode = "round-robin";
    saveConfig(cfg, dataDir);
    expect(gatherSidebarData(cfgDir).routingMode).toBe("round-robin");
  });

  it("accounts settings offers the general Model Manager routing mode selector", () => {
    writeProviderCreds(cfgDir, ["antigravity"]);
    const h = makeApi();
    accountsSettings(h.api as never);
    const routingManager = h.find("routing-manager");
    expect(routingManager).toBeTruthy();
    expect(routingManager!.title).toMatch(/Model Manager routing mode/);

    // Open the selector and pick round-robin -> scope dialog -> all -> persists to manager config.
    routingManager!.onSelect!();
    const roundRobin = h.find("round-robin");
    expect(roundRobin).toBeTruthy();
    roundRobin!.onSelect!();
    const scopeAll = h.find("all");
    expect(scopeAll).toBeTruthy();
    scopeAll!.onSelect!();
    expect(loadConfig().router.routingMode).toBe("round-robin");
  });

  it("toggleManager, toggleOpenai, and toggleAntigravity update signals and persist preferences", async () => {
    // Start with known states
    const initManager = managerCollapsed();
    toggleManager();
    expect(managerCollapsed()).toBe(!initManager);

    const initOpenai = openaiCollapsed();
    toggleOpenai();
    expect(openaiCollapsed()).toBe(!initOpenai);

    const initAg = antigravityCollapsed();
    toggleAntigravity();
    expect(antigravityCollapsed()).toBe(!initAg);

    // Save preferences directly to cfgDir and verify readPreferences
    await savePreference("model-manager", true, cfgDir);
    await savePreference("openai-auth", true, cfgDir);
    await savePreference("antigravity-auth", false, cfgDir);

    const read = readPreferences(cfgDir);
    expect(read.managerCollapsed).toBe(true);
    expect(read.openaiCollapsed).toBe(true);
    expect(read.antigravityCollapsed).toBe(false);

    // Toggle back
    toggleManager();
    toggleOpenai();
    toggleAntigravity();
    expect(managerCollapsed()).toBe(initManager);
    expect(openaiCollapsed()).toBe(initOpenai);
    expect(antigravityCollapsed()).toBe(initAg);
  });

  it("registers sidebar_content slot and handles toggles correctly", async () => {
    const h = makeApi();
    await tuiDefault.tui(h.api as never, undefined, undefined as never);
    expect((h.api.slots as { register: ReturnType<typeof vi.fn> }).register).toHaveBeenCalledWith(
      expect.objectContaining({
        order: 100,
        slots: expect.objectContaining({
          sidebar_content: expect.any(Function),
        }),
      })
    );

    // Initial states
    expect(typeof managerCollapsed()).toBe("boolean");
    expect(typeof openaiCollapsed()).toBe("boolean");
    expect(typeof antigravityCollapsed()).toBe("boolean");

    // Toggle manager
    const m1 = managerCollapsed();
    toggleManager();
    expect(managerCollapsed()).toBe(!m1);

    // Toggle openai
    const o1 = openaiCollapsed();
    toggleOpenai();
    expect(openaiCollapsed()).toBe(!o1);

    // Toggle antigravity
    const a1 = antigravityCollapsed();
    toggleAntigravity();
    expect(antigravityCollapsed()).toBe(!a1);

    // Restore
    toggleManager();
    toggleOpenai();
    toggleAntigravity();
    expect(managerCollapsed()).toBe(m1);
    expect(openaiCollapsed()).toBe(o1);
    expect(antigravityCollapsed()).toBe(a1);
  });

  it("formatCleanModelName strips Antigravity and produces clean labels", () => {
    expect(formatCleanModelName("google/antigravity-gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
    expect(formatCleanModelName("google/antigravity-gemini-3.8-flash", "Gemini 3.8 Flash (Antigravity)")).toBe("Gemini 3.8 Flash");
    expect(formatCleanModelName("google/gemini-2.5-flash-thinking")).toBe("Gemini 2.5 Flash Thinking");
    expect(formatCleanModelName("openai/gpt-6-astra")).toBe("GPT-6 Astra");
    expect(formatCleanModelName("iit/deepseek-v4-flash")).toBe("DeepSeek V4 Flash");
  });

  it("routerSettings opens orchestrator menu, supports Back navigation, and does not advance tiers on Done", () => {
    writeProviderCreds(cfgDir, ["antigravity", "openai"]);
    const h = makeApi();
    routerSettings(h.api as never);

    // Verify dialog was set to xlarge
    expect((h.api.ui as { dialog: { setSize: ReturnType<typeof vi.fn> } }).dialog.setSize).toHaveBeenCalledWith("xlarge");

    // 1. Click Orchestrator option -> should open orchestrator menu (not text input)
    const orchOpt = h.find("orch");
    expect(orchOpt).toBeTruthy();
    expect(orchOpt!.title).toContain("Orchestrator");
    orchOpt!.onSelect!();

    // In Orchestrator menu
    expect(h.last()?.title).toContain("Orchestrator");
    const chooseModel = h.find("model");
    expect(chooseModel).toBeTruthy();
    const chooseAccount = h.find("account");
    expect(chooseAccount).toBeTruthy();
    const fallbacks = h.find("fallbacks");
    expect(fallbacks).toBeTruthy();

    // Back from Orchestrator menu -> returns to router settings
    const backToRouter = h.find("__back");
    expect(backToRouter).toBeTruthy();
    backToRouter!.onSelect!();
    expect(h.last()?.title).toContain("Router settings");

    // 2. Open heavy tier fallback editor
    h.find("heavy")!.onSelect!();
    expect(h.last()?.title).toContain("HEAVY");

    // Done button returns to routerSettings, never auto-advances wizard
    const doneOpt = h.find("__done");
    expect(doneOpt).toBeTruthy();
    doneOpt!.onSelect!();
    expect(h.last()?.title).toContain("Router settings");

    // 3. Sub-menu Back button inside a fallback item
    h.find("heavy")!.onSelect!();
    // Add a fallback so list is not empty
    h.find("__add")!.onSelect!();
    const m = h.last()!.options!.find(o => !o.value.startsWith("__"));
    m!.onSelect!();
    const vOpt = h.last()!.options!.find(o => o.value === "");
    if (vOpt) vOpt.onSelect!();
    h.find("__none")!.onSelect!();

    // Click on the fallback item
    const fbItem = h.last()!.options!.find(o => o.value.startsWith("openai/") || o.value.startsWith("google/") || o.value.startsWith("iit/"));
    expect(fbItem).toBeTruthy();
    fbItem!.onSelect!();

    // Sub-dialog opened: click Back
    const subBack = h.find("__back");
    expect(subBack).toBeTruthy();
    subBack!.onSelect!();
    // Successfully returned to HEAVY chain editor!
    expect(h.last()?.title).toContain("HEAVY");
  });

  it("UNIFIED_ROUTING_OPTIONS exposes the 4 unified options with detailed descriptions", () => {
    const values = UNIFIED_ROUTING_OPTIONS.map(o => o.value);
    expect(values).toEqual(["main-first", "round-robin", "fallback-first", "balanced"]);
    for (const opt of UNIFIED_ROUTING_OPTIONS) {
      expect(opt.title).toBeTruthy();
      expect(opt.description).toBeTruthy();
    }
  });

  it("openRoutingSelector presents all 4 options and prompts for scope (session vs all)", () => {
    const h = makeApi();
    openRoutingSelector(h.api as never, "manager");

    expect(h.last()?.title).toContain("Model Manager routing mode");
    const balanced = h.find("balanced");
    expect(balanced).toBeTruthy();
    expect(balanced!.title).toBe("Balanced");

    // Select balanced -> scope prompt appears
    balanced!.onSelect!();
    expect(h.last()?.title).toContain("Choose scope");
    const scopeSession = h.find("session");
    const scopeAll = h.find("all");
    expect(scopeSession).toBeTruthy();
    expect(scopeAll).toBeTruthy();

    // Select session scope
    scopeSession!.onSelect!();
    expect(h.api.ui as any).toBeTruthy();
  });

  it("routing selector dialog stays open until user dismisses it (does not auto-close)", () => {
    const h = makeApi();
    openRoutingSelector(h.api as never, "openai");

    // Dialog is open with all 4 options
    expect(h.last()?.title).toContain("OpenAI account routing mode");
    expect(h.find("main-first")).toBeTruthy();
    expect(h.find("round-robin")).toBeTruthy();
    expect(h.find("fallback-first")).toBeTruthy();
    expect(h.find("balanced")).toBeTruthy();

    // Selecting an option opens the scope prompt (dialog remains open, not cleared)
    h.find("balanced")!.onSelect!();
    expect(h.last()?.title).toContain("Choose scope");
    expect(h.last()).not.toBeNull();

    // Choosing a scope applies the change; dialog is replaced by the next view, not auto-closed
    h.find("session")!.onSelect!();
    expect(h.last()).not.toBeNull();
  });

  it("toggleZen toggles signal and preferences file tracks zenCollapsed", async () => {
    const initZen = zenCollapsed();
    toggleZen();
    expect(zenCollapsed()).toBe(!initZen);

    await savePreference("opencode-zen", true, cfgDir);
    const read = readPreferences(cfgDir);
    expect(read.zenCollapsed).toBe(true);

    toggleZen();
    expect(zenCollapsed()).toBe(initZen);
  });

  it("formatRoutingDisplay formats standard routing names cleanly", () => {
    expect(formatRoutingDisplay("main-first")).toBe("Main first");
    expect(formatRoutingDisplay("round-robin")).toBe("Round robin");
    expect(formatRoutingDisplay("fallback-first")).toBe("Fallback first");
    expect(formatRoutingDisplay("balanced")).toBe("Balanced");
    expect(formatRoutingDisplay("sticky")).toBe("Main first");
    expect(formatRoutingDisplay("least-used")).toBe("Balanced");
  });

  it("gatherSidebarData includes opencodeZen status with big-pickle", () => {
    const data = gatherSidebarData(cfgDir);
    expect(data.opencodeZen).toBeDefined();
    expect(data.opencodeZen.model).toBe("big-pickle");
    expect(typeof data.opencodeZen.usedPct).toBe("number");
    expect(typeof data.opencodeZen.totalTokens24h).toBe("number");
  });
});
