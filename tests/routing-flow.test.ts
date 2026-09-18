import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGoogleRoutingMode,
  setGoogleRoutingMode,
  openRoutingSelector,
  promptRoutingScope,
} from "../src/tui/dialogs.js";
import { gatherSidebarData, formatRoutingDisplay } from "../src/tui/sidebar-widget.js";
import { loadConfig, saveConfig } from "../src/manager/index.js";
import { writeProviderCreds } from "./helpers.js";

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
}

function makeApi(): Harness {
  let last: AnyDialog | null = null;
  const command = vi.fn(async () => ({}));
  const setState = (render: () => unknown) => { last = render() as AnyDialog; };
  const api = {
    route: {
      get current() { return { name: "session", params: { sessionID: "s1" } }; },
      register: vi.fn(),
      navigate: vi.fn(),
    },
    client: { session: { command }, tui: {} },
    state: { provider: [] as never[] },
    slots: { register: vi.fn() },
    ui: {
      dialog: { replace: setState, clear: () => { last = null; }, setSize: vi.fn(), size: "xlarge", depth: 1, open: true },
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
  };
}

function writeGoogleConfig(configDir: string, strategy: string) {
  writeFileSync(join(configDir, "google.json"), JSON.stringify({ account_selection_strategy: strategy }, null, 2));
}

describe("routing flow", () => {
  let cfgDir: string;
  beforeEach(() => {
    cfgDir = mkdtempSync(join(tmpdir(), "routing-"));
    process.env.OPENCODE_CONFIG_DIR = cfgDir;
  });

  it("getGoogleRoutingMode reads all 4 modes accurately from config", () => {
    writeGoogleConfig(cfgDir, "sticky-balanced");
    expect(getGoogleRoutingMode()).toBe("sticky-balanced");

    writeGoogleConfig(cfgDir, "hybrid");
    expect(getGoogleRoutingMode()).toBe("sticky-balanced");

    writeGoogleConfig(cfgDir, "balanced");
    expect(getGoogleRoutingMode()).toBe("sticky-balanced");

    writeGoogleConfig(cfgDir, "main-first");
    expect(getGoogleRoutingMode()).toBe("main-first");

    writeGoogleConfig(cfgDir, "sticky");
    expect(getGoogleRoutingMode()).toBe("main-first");

    writeGoogleConfig(cfgDir, "round-robin");
    expect(getGoogleRoutingMode()).toBe("round-robin");

    writeGoogleConfig(cfgDir, "fallback-first");
    expect(getGoogleRoutingMode()).toBe("fallback-first");
  });

  it("setGoogleRoutingMode updates google.json without injecting commands into session.command", () => {
    writeGoogleConfig(cfgDir, "main-first");
    const h = makeApi();

    setGoogleRoutingMode(h.api as never, "round-robin", "all");

    const saved = JSON.parse(readFileSync(join(cfgDir, "google.json"), "utf8"));
    expect(saved.account_selection_strategy).toBe("round-robin");
    expect(saved.routing_mode).toBeUndefined();
    expect(saved.scheduling_mode).toBe("performance_first");
    expect(saved.switch_on_first_rate_limit).toBe(true);
    expect(h.command).not.toHaveBeenCalled();
  });

  it("setGoogleRoutingMode persists sticky-balanced and fallback-first scheduling", () => {
    const h = makeApi();

    setGoogleRoutingMode(h.api as never, "sticky-balanced", "all");
    let saved = JSON.parse(readFileSync(join(cfgDir, "google.json"), "utf8"));
    expect(saved.account_selection_strategy).toBe("sticky-balanced");
    expect(saved.scheduling_mode).toBe("balance");
    expect(saved.switch_on_first_rate_limit).toBe(true);

    setGoogleRoutingMode(h.api as never, "fallback-first", "all");
    saved = JSON.parse(readFileSync(join(cfgDir, "google.json"), "utf8"));
    expect(saved.account_selection_strategy).toBe("fallback-first");
    expect(saved.scheduling_mode).toBe("balance");
    expect(saved.switch_on_first_rate_limit).toBe(true);
  });

  it("closeDialog is invoked on < Back in the routing selector", () => {
    const h = makeApi();
    openRoutingSelector(h.api as never, "google");
    const back = h.find("__back");
    expect(back).toBeTruthy();
    back!.onSelect!();
    expect(h.last()).toBeNull();
  });

  it("closeDialog is invoked after scope selection", () => {
    const h = makeApi();
    openRoutingSelector(h.api as never, "google");
    const mode = h.find("round-robin");
    expect(mode).toBeTruthy();
    mode!.onSelect!();
    // Scope dialog is now open.
    expect(h.last()?.title).toContain("Choose scope");
    const scopeAll = h.find("all");
    expect(scopeAll).toBeTruthy();
    scopeAll!.onSelect!();
    // Scope selection closes the dialog.
    expect(h.last()).toBeNull();
  });

  it("promptRoutingScope closes the dialog on scope selection", () => {
    const h = makeApi();
    const onScope = vi.fn();
    promptRoutingScope(h.api as never, "Google routing", onScope);
    const scopeSession = h.find("session");
    expect(scopeSession).toBeTruthy();
    scopeSession!.onSelect!();
    expect(onScope).toHaveBeenCalledWith("session");
    expect(h.last()).toBeNull();
  });

  it("gatherSidebarData returns antigravity.routingMode from google.json", () => {
    writeProviderCreds(cfgDir, ["antigravity"]);
    const cfg = loadConfig();
    saveConfig(cfg, cfgDir);

    writeGoogleConfig(cfgDir, "sticky-balanced");
    expect(gatherSidebarData(cfgDir).antigravity.routingMode).toBe("sticky-balanced");

    writeGoogleConfig(cfgDir, "round-robin");
    expect(gatherSidebarData(cfgDir).antigravity.routingMode).toBe("round-robin");

    writeGoogleConfig(cfgDir, "fallback-first");
    expect(gatherSidebarData(cfgDir).antigravity.routingMode).toBe("fallback-first");

    writeGoogleConfig(cfgDir, "main-first");
    expect(gatherSidebarData(cfgDir).antigravity.routingMode).toBe("main-first");
  });

  it("gatherSidebarData falls back to antigravity.json when google.json is absent", () => {
    writeProviderCreds(cfgDir, ["antigravity"]);
    const cfg = loadConfig();
    saveConfig(cfg, cfgDir);

    writeFileSync(join(cfgDir, "antigravity.json"), JSON.stringify({ account_selection_strategy: "round-robin" }, null, 2));
    expect(existsSync(join(cfgDir, "google.json"))).toBe(false);
    expect(gatherSidebarData(cfgDir).antigravity.routingMode).toBe("round-robin");
  });

  it("formatRoutingDisplay formats the routing mode cleanly", () => {
    expect(formatRoutingDisplay("sticky-balanced")).toBe("Sticky balanced");
    expect(formatRoutingDisplay("main-first")).toBe("Main first");
    expect(formatRoutingDisplay("round-robin")).toBe("Round robin");
    expect(formatRoutingDisplay("fallback-first")).toBe("Fallback first");
    expect(formatRoutingDisplay("")).toBe("Main first");
  });
});
