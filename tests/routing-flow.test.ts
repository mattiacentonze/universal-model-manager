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
import { loadConfig, saveConfig, syncUnifiedRouting, translateToProvider } from "../src/manager/index.js";
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

describe("routing flow with unified 5 modes", () => {
  let cfgDir: string;
  beforeEach(() => {
    cfgDir = mkdtempSync(join(tmpdir(), "routing-"));
    process.env.OPENCODE_CONFIG_DIR = cfgDir;
  });

  it("getGoogleRoutingMode reads modes accurately from config", () => {
    writeGoogleConfig(cfgDir, "sticky-balanced");
    expect(getGoogleRoutingMode()).toBe("load-balancing");

    writeGoogleConfig(cfgDir, "main-first");
    expect(getGoogleRoutingMode()).toBe("main-first");

    writeGoogleConfig(cfgDir, "round-robin");
    expect(getGoogleRoutingMode()).toBe("load-balancing");

    writeGoogleConfig(cfgDir, "latency-based");
    expect(getGoogleRoutingMode()).toBe("latency-based");

    writeGoogleConfig(cfgDir, "cost-based");
    expect(getGoogleRoutingMode()).toBe("cost-based");

    writeGoogleConfig(cfgDir, "usage-based");
    expect(getGoogleRoutingMode()).toBe("usage-based");
  });

  it("setGoogleRoutingMode updates config via syncUnifiedRouting without injecting into session.command", async () => {
    const cfg = loadConfig(cfgDir);
    saveConfig(cfg, cfgDir);
    const h = makeApi();

    setGoogleRoutingMode(h.api as never, "load-balancing", "all");

    // Wait a tick for async write
    await new Promise(r => setTimeout(r, 50));

    const saved = JSON.parse(readFileSync(join(cfgDir, "google.json"), "utf8"));
    expect(saved.account_selection_strategy).toBe("round-robin");
    expect(saved.routing_mode).toBeUndefined();
    expect(saved.scheduling_mode).toBe("performance_first");
    expect(saved.switch_on_first_rate_limit).toBe(true);
    expect(h.command).not.toHaveBeenCalled();
  });

  it("syncUnifiedRouting persists across all providers with static parameter mappings", async () => {
    const cfg = loadConfig(cfgDir);
    saveConfig(cfg, cfgDir);
    const h = makeApi();

    await syncUnifiedRouting(h.api as never, "latency-based");

    const savedGoogle = JSON.parse(readFileSync(join(cfgDir, "google.json"), "utf8"));
    expect(savedGoogle.account_selection_strategy).toBe("hybrid");
    expect(savedGoogle.scheduling_mode).toBe("balance");
    expect(savedGoogle.switch_on_first_rate_limit).toBe(true);
    expect(savedGoogle.soft_quota_threshold_percent).toBe(80);

    const savedOai = JSON.parse(readFileSync(join(cfgDir, "openai-auth.json"), "utf8"));
    expect(savedOai.routing.mode).toBe("sticky-balanced");

    const savedManager = loadConfig(cfgDir);
    expect(savedManager.router.routing?.mode).toBe("latency-based");
    expect(savedManager.router.routing?.parameters.latencyWindowMs).toBe(60000);
  });

  it("closeDialog is invoked on < Back in the routing selector", () => {
    const h = makeApi();
    openRoutingSelector(h.api as never, "google");
    const back = h.find("__back");
    expect(back).toBeTruthy();
    back!.onSelect!();
    expect(h.last()).toBeNull();
  });

  it("selection directly applies routing and closes dialog (removing fake session scope)", async () => {
    const cfg = loadConfig(cfgDir);
    saveConfig(cfg, cfgDir);
    const h = makeApi();
    openRoutingSelector(h.api as never, "google");
    const mode = h.find("load-balancing");
    expect(mode).toBeTruthy();
    mode!.onSelect!();

    await new Promise(r => setTimeout(r, 50));
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

  it("gatherSidebarData returns routingMode", () => {
    writeProviderCreds(cfgDir, ["antigravity"]);
    const cfg = loadConfig(cfgDir);
    cfg.router.routing = {
      mode: "cost-based",
      parameters: {
        softQuotaThresholdPercent: 80,
        proactiveRotationThresholdPercent: 20,
        switchOnFirstRateLimit: true,
        maxAccountSwitches: 10,
        maxCacheFirstWaitSeconds: 60,
        pidOffsetEnabled: false,
        latencyWindowMs: 60000,
        costWindowMs: 86400000,
      },
    };
    saveConfig(cfg, cfgDir);

    const sidebar = gatherSidebarData(cfgDir);
    expect(sidebar.routingMode).toBe("cost-based");
  });

  it("formatRoutingDisplay formats the 5 routing modes cleanly", () => {
    expect(formatRoutingDisplay("main-first")).toBe("Main first");
    expect(formatRoutingDisplay("load-balancing")).toBe("Load balancing");
    expect(formatRoutingDisplay("latency-based")).toBe("Latency based");
    expect(formatRoutingDisplay("cost-based")).toBe("Cost based");
    expect(formatRoutingDisplay("usage-based")).toBe("Usage based");
    expect(formatRoutingDisplay("round-robin")).toBe("Round robin");
    expect(formatRoutingDisplay("fallback-first")).toBe("Fallback first");
    expect(formatRoutingDisplay("")).toBe("Main first");
  });
});
