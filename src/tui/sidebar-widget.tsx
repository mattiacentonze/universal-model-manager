import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { readFileSync, writeFileSync, existsSync, watch } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { parse, modify, applyEdits } from "jsonc-parser";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { loadConfig } from "../manager/store.js";
import { getOpenCodeConfigDir } from "../shared/paths.js";
import { usageTracker } from "../chatgpt-web/usage-tracker.js";
import { zenUsageTracker, type ZenPacingResult } from "../opencode-zen/usage-tracker.js";
import { getAntigravityAccounts, getAntigravityActiveFamilies, isOpencodeConfigured } from "../manager/provider-accounts.js";
import { openRoutingSelector } from "./dialogs.js";

type Api = TuiPluginApi;

const SINGLE_BORDER = { type: "single" } as any;

const PACE_RESERVE_CHAR = "\u2592"; // ▒
const PACE_DEFICIT_CHAR = "\u2593"; // ▓
const BAR_FILLED_CHAR = "\u2588"; // █
const BAR_EMPTY_CHAR = "\u2591"; // ░

const PACING_MIN_ELAPSED_MS = 5 * 60 * 1000;
const PACING_MIN_ELAPSED_FRACTION = 0.01;
const ON_PACE_DELTA = 1;

export function formatRoutingDisplay(mode: string): string {
  if (!mode) return "Main first";
  const m = mode.toLowerCase();
  if (m.includes("round-robin") || m.includes("round robin")) return "Round robin";
  if (m.includes("fallback-first") || m.includes("fallback first")) return "Fallback first";
  if (m.includes("balanced") || m.includes("least-used") || m.includes("hybrid")) return "Sticky balanced";
  if (m.includes("sticky")) return "Main first";
  if (m.includes("main-first") || m.includes("main first")) return "Main first";
  return mode;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function getTuiPreferencesFile(configDir = getOpenCodeConfigDir()): string {
  const env = process.env.OPENCODE_TUI_PREFERENCES_FILE;
  if (env) return env;
  return join(configDir, "tui-preferences.jsonc");
}

export function readPreferences(configDir = getOpenCodeConfigDir()): {
  openaiCollapsed: boolean;
  antigravityCollapsed: boolean;
  managerCollapsed: boolean;
  zenCollapsed: boolean;
} {
  const file = getTuiPreferencesFile(configDir);
  let openaiCollapsed = false;
  let antigravityCollapsed = false;
  let managerCollapsed = false;
  let zenCollapsed = false;
  try {
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      const root = parse(text, [], { allowTrailingComma: true });
      if (root && typeof root === "object") {
        if (typeof root["openai-auth"]?.collapsed === "boolean") {
          openaiCollapsed = root["openai-auth"].collapsed;
        }
        if (typeof root["antigravity-auth"]?.collapsed === "boolean") {
          antigravityCollapsed = root["antigravity-auth"].collapsed;
        }
        if (typeof root["model-manager"]?.collapsed === "boolean") {
          managerCollapsed = root["model-manager"].collapsed;
        }
        if (typeof root["opencode-zen"]?.collapsed === "boolean") {
          zenCollapsed = root["opencode-zen"].collapsed;
        }
      }
    }
  } catch {}
  return { openaiCollapsed, antigravityCollapsed, managerCollapsed, zenCollapsed };
}

let savePromise: Promise<void> = Promise.resolve();
export function savePreference(key: string, collapsed: boolean, configDir = getOpenCodeConfigDir()): Promise<void> {
  savePromise = savePromise.then(async () => {
    const file = getTuiPreferencesFile(configDir);
    try {
      let text = existsSync(file) ? readFileSync(file, "utf8") : "{\n}\n";
      const edits = modify(text, [key, "collapsed"], collapsed, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      const next = applyEdits(text, edits);
      writeFileSync(file, next, "utf8");
    } catch {}
  });
  return savePromise;
}

// Module-level signals initialized from preferences file.
// Survives re-renders and slot unmounts/remounts.
const initialPrefs = readPreferences();
export const [openaiCollapsed, setOpenaiCollapsed] = createSignal(initialPrefs.openaiCollapsed);
export const [antigravityCollapsed, setAntigravityCollapsed] = createSignal(initialPrefs.antigravityCollapsed);
export const [managerCollapsed, setManagerCollapsed] = createSignal(initialPrefs.managerCollapsed);
export const [zenCollapsed, setZenCollapsed] = createSignal(initialPrefs.zenCollapsed);

export function toggleOpenai(): void {
  const next = !openaiCollapsed();
  setOpenaiCollapsed(next);
  void savePreference("openai-auth", next);
}

export function toggleAntigravity(): void {
  const next = !antigravityCollapsed();
  setAntigravityCollapsed(next);
  void savePreference("antigravity-auth", next);
}

export function toggleManager(): void {
  const next = !managerCollapsed();
  setManagerCollapsed(next);
  void savePreference("model-manager", next);
}

export function toggleZen(): void {
  const next = !zenCollapsed();
  setZenCollapsed(next);
  void savePreference("opencode-zen", next);
}

// Watch preferences file for external updates
try {
  const prefsFile = getTuiPreferencesFile();
  if (existsSync(prefsFile)) {
    const watcher = watch(prefsFile, { persistent: false }, () => {
      const p = readPreferences();
      if (p.openaiCollapsed !== openaiCollapsed()) setOpenaiCollapsed(p.openaiCollapsed);
      if (p.antigravityCollapsed !== antigravityCollapsed()) setAntigravityCollapsed(p.antigravityCollapsed);
      if (p.managerCollapsed !== managerCollapsed()) setManagerCollapsed(p.managerCollapsed);
      if (p.zenCollapsed !== zenCollapsed()) setZenCollapsed(p.zenCollapsed);
    });
    watcher.unref?.();
  }
} catch {}

function safeReadJson(filePath: string): any | null {
  try {
    if (!filePath || !existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

function formatReset(resetsAt: string | number | undefined): string {
  if (!resetsAt) return "";
  const time = typeof resetsAt === "string" ? new Date(resetsAt).getTime() : resetsAt;
  const ms = time - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hrs < 24) return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `${days}d${rh}h` : `${days}d`;
}

interface BarSegment {
  text: string;
  tone: "ok" | "warn" | "err" | "muted";
}

interface PacingResult {
  pacePercent: number;
  deltaPercent: number;
  state: "on-pace" | "deficit" | "reserve";
  runsOutAt: string | null;
}

function computePacing(
  window: { usedPercent: number; resetsAt?: string } | undefined,
  windowMs: number,
  now: number
): PacingResult | null {
  if (!window?.resetsAt) return null;
  const resetsAt = new Date(window.resetsAt).getTime();
  if (!Number.isFinite(resetsAt)) return null;
  const start = resetsAt - windowMs;
  const elapsed = now - start;
  if (elapsed < PACING_MIN_ELAPSED_MS) return null;
  if (elapsed < windowMs * PACING_MIN_ELAPSED_FRACTION) return null;
  if (elapsed >= windowMs) return null;

  const used = window.usedPercent;
  const pacePercent = Math.min(Math.max((elapsed / windowMs) * 100, 0), 100);
  const deltaPercent = used - pacePercent;
  const state = Math.abs(deltaPercent) < ON_PACE_DELTA ? "on-pace" : deltaPercent > 0 ? "deficit" : "reserve";

  let runsOutAt: string | null = null;
  if (used > 0) {
    const msToFull = (elapsed * 100) / used;
    const runOut = start + msToFull;
    if (runOut < resetsAt) runsOutAt = new Date(runOut).toISOString();
  }

  return { pacePercent, deltaPercent, state, runsOutAt };
}

function quotaBarSegments(usedPct: number, width = 10, pacing?: PacingResult | null): BarSegment[] {
  const cells = (pct: number) => Math.max(0, Math.min(Math.round((pct / 100) * width), width));
  const usedCells = cells(usedPct);
  const fillTone: BarSegment["tone"] = usedPct >= 80 ? "err" : usedPct >= 50 ? "warn" : "ok";

  const plain: BarSegment[] = [
    { text: BAR_FILLED_CHAR.repeat(usedCells), tone: fillTone },
    { text: BAR_EMPTY_CHAR.repeat(width - usedCells), tone: fillTone },
  ];
  if (!pacing) return plain.filter(s => s.text.length > 0);

  const paceCells = cells(pacing.pacePercent);
  const lo = Math.min(usedCells, paceCells);
  const hi = Math.max(usedCells, paceCells);
  if (hi === lo) return plain.filter(s => s.text.length > 0);

  const overspent = usedCells > paceCells;
  return [
    { text: BAR_FILLED_CHAR.repeat(lo), tone: fillTone },
    { text: (overspent ? PACE_DEFICIT_CHAR : PACE_RESERVE_CHAR).repeat(hi - lo), tone: (overspent ? "err" : "ok") as BarSegment["tone"] },
    { text: BAR_EMPTY_CHAR.repeat(width - hi), tone: fillTone },
  ].filter(s => s.text.length > 0);
}

function toneColor(theme: any, tone: string): string {
  switch (tone) {
    case "ok":
      return theme?.success ?? "#22c55e";
    case "warn":
      return theme?.warning ?? "#eab308";
    case "err":
      return theme?.error ?? "#ef4444";
    case "muted":
      return theme?.textMuted ?? "#888888";
    case "accent":
      return theme?.accent ?? "#a855f7";
    case "text":
    default:
      return theme?.text ?? "#ffffff";
  }
}

export interface OpenAiDisplayWindow {
  label: string;
  usedPct: number;
  reset?: string;
  pacing?: PacingResult | null;
}

export interface OpenAiDisplayAccount {
  id: string;
  name: string;
  active: boolean;
  windows: OpenAiDisplayWindow[];
  resets?: number;
}

export interface AntigravityDisplayPool {
  label: string;
  usedPct: number;
  reset?: string;
}

export interface AntigravityDisplayFamily {
  name: string;
  pools: AntigravityDisplayPool[];
}

export interface AntigravityDisplayAccount {
  id: string;
  label: string;
  active: boolean;
  /** Human label of the family(ies) this account is active for, e.g. "Gemini". */
  activeFor?: string;
  families: AntigravityDisplayFamily[];
  health: number;
}

export interface OpenCodeZenDisplayData {
  isConfigured: boolean;
  model: string;
  usedPct: number;
  totalTokens24h: number;
  inputTokens24h: number;
  outputTokens24h: number;
  estimatedLimit: number;
  pacing: ZenPacingResult | null;
  resetsIn: string;
  isRateLimited: boolean;
  rateLimitResetFormatted: string | null;
  routingMode: string;
}

export interface UnifiedSidebarData {
  routingMode: string;
  openai: {
    accounts: OpenAiDisplayAccount[];
    routingMode: string;
  };
  chatgptWeb: {
    exists: boolean;
    alias?: string;
    isLoggedIn: boolean;
    tier: string;
    turns: number;
    reset?: string;
  };
  antigravity: {
    accounts: AntigravityDisplayAccount[];
    routeSummary: string;
  };
  opencodeZen: OpenCodeZenDisplayData;
}

export function gatherSidebarData(configDir = getOpenCodeConfigDir(), sessionId?: string): UnifiedSidebarData {
  const cfg = loadConfig(undefined, configDir);
  const now = Date.now();

  // 1. OPENAI STATE
  const oaPaths = [
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE,
    join(tmpdir(), "opencode-openai-auth", "sidebar-state.json"),
    join(configDir, "sidebar-state.json"),
    join(homedir(), ".local", "state", "cortexkit", "openai-auth", "sidebar-state.json"),
  ].filter(Boolean) as string[];

  let oaState: any = null;
  for (const p of oaPaths) {
    oaState = safeReadJson(p);
    if (oaState) break;
  }

  const oaAuth = safeReadJson(join(configDir, "openai-auth.json"));
  const oaRoutingMode = oaState?.route || oaAuth?.routing?.mode || "main-first";
  const oaAccounts: OpenAiDisplayAccount[] = [];

  const activeOaId =
    sessionId && oaState?.activeRouting?.[sessionId]?.activeId
      ? oaState.activeRouting[sessionId].activeId
      : oaState?.activeId ?? "main";

  const mainQuota = oaState?.main?.quota;
  const mainAlias = cfg.accounts.find(a => a.kind === "openai" && a.main)?.alias;

  if (mainQuota) {
    const windows: OpenAiDisplayWindow[] = [];
    if (mainQuota.primary) {
      windows.push({
        label: "5h",
        usedPct: mainQuota.primary.usedPercent ?? 0,
        reset: formatReset(mainQuota.primary.resetsAt),
        pacing: computePacing(mainQuota.primary, 300 * 60 * 1000, now),
      });
    }
    if (mainQuota.secondary) {
      windows.push({
        label: "7d",
        usedPct: mainQuota.secondary.usedPercent ?? 0,
        reset: formatReset(mainQuota.secondary.resetsAt),
        pacing: computePacing(mainQuota.secondary, 10080 * 60 * 1000, now),
      });
    }
    oaAccounts.push({
      id: "main",
      name: mainAlias || "main",
      active: activeOaId === "main",
      windows,
      resets: oaState.main?.resetCredits ?? mainQuota.resetCreditsAvailable ?? 0,
    });
  } else {
    // Fallback display if no quota yet
    oaAccounts.push({
      id: "main",
      name: mainAlias || "main",
      active: activeOaId === "main",
      windows: [
        { label: "5h", usedPct: 0, reset: "" },
        { label: "7d", usedPct: 0, reset: "" },
      ],
      resets: 0,
    });
  }

  // OpenAI Fallbacks
  if (Array.isArray(oaState?.fallbacks)) {
    for (const fb of oaState.fallbacks) {
      if (fb.enabled === false) continue;
      const fbAlias = cfg.accounts.find(a => a.id === fb.id || a.label === fb.label)?.alias;
      const fbQuota = fb.quota;
      const windows: OpenAiDisplayWindow[] = [];
      if (fbQuota?.primary) {
        windows.push({
          label: "5h",
          usedPct: fbQuota.primary.usedPercent ?? 0,
          reset: formatReset(fbQuota.primary.resetsAt),
          pacing: computePacing(fbQuota.primary, 300 * 60 * 1000, now),
        });
      }
      if (fbQuota?.secondary) {
        windows.push({
          label: "7d",
          usedPct: fbQuota.secondary.usedPercent ?? 0,
          reset: formatReset(fbQuota.secondary.resetsAt),
          pacing: computePacing(fbQuota.secondary, 10080 * 60 * 1000, now),
        });
      }
      oaAccounts.push({
        id: fb.id,
        name: fbAlias || fb.label || fb.id,
        active: activeOaId === fb.id,
        windows,
        resets: fb.resetCredits ?? fbQuota?.resetCreditsAvailable ?? 0,
      });
    }
  } else if (Array.isArray(oaAuth?.accounts)) {
    for (const fb of oaAuth.accounts) {
      if (fb.enabled === false) continue;
      const fbAlias = cfg.accounts.find(a => a.id === fb.id || a.label === fb.label)?.alias;
      oaAccounts.push({
        id: fb.id,
        name: fbAlias || fb.label || fb.id,
        active: activeOaId === fb.id,
        windows: [
          { label: "5h", usedPct: 0, reset: "" },
          { label: "7d", usedPct: 0, reset: "" },
        ],
        resets: 0,
      });
    }
  }

  // 2. CHATGPT WEB (only if account exists)
  const webAcct = cfg.accounts.find(a => a.kind === "chatgpt-web");
  const webStatus = usageTracker.getStatus();
  const chatgptWeb = {
    exists: Boolean(webAcct),
    alias: webAcct?.alias,
    isLoggedIn: webStatus.isLoggedIn,
    tier: webStatus.tier,
    turns: webStatus.turnsInWindow,
    reset: webStatus.rateLimitResetFormatted ?? undefined,
  };

  // 3. ANTIGRAVITY STATE
  const agPaths = [
    process.env.ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE,
    join(homedir(), ".local", "state", "cortexkit", "antigravity-auth", "sidebar-state.json"),
    join(homedir(), ".local", "state", "opencode-antigravity-auth", "sidebar-state.json"),
  ].filter(Boolean) as string[];

  let agState: any = null;
  for (const p of agPaths) {
    agState = safeReadJson(p);
    if (agState) break;
  }

  const agAccounts: AntigravityDisplayAccount[] = [];
  // Real Antigravity accounts in store order (index-aligned with the redacted
  // sidebar state) and a label -> manager-account map to resolve aliases.
  const realAnti = getAntigravityAccounts(configDir);
  const activeFamilies = getAntigravityActiveFamilies(configDir);
  const antiByLabel = new Map(
    cfg.accounts
      .filter(x => x.kind === "antigravity")
      .map(x => [x.label, x])
  );
  if (Array.isArray(agState?.accounts) && agState.accounts.length > 0) {
    for (const a of agState.accounts) {
      if (a.enabled === false) continue;
      const families: AntigravityDisplayFamily[] = [];
      const gq = a.quota?.gemini;
      const cq = a.quota?.["non-gemini"];

      const buildPools = (q: any): AntigravityDisplayPool[] => {
        const pools: AntigravityDisplayPool[] = [];
        if (q?.windows && q.windows.length > 0) {
          for (const w of q.windows) {
            pools.push({
              label: w.window === "weekly" ? "7d" : w.window,
              usedPct: 100 - clamp(w.remainingPercent ?? 0, 0, 100),
              reset: formatReset(w.resetAt),
            });
          }
        } else if (q) {
          pools.push({
            label: "",
            usedPct: 100 - clamp(q.remainingPercent ?? 0, 0, 100),
            reset: formatReset(q.resetAt),
          });
        }
        return pools;
      };

      const geminiPools = buildPools(gq);
      if (geminiPools.length > 0) families.push({ name: "Gem", pools: geminiPools });
      const otherPools = buildPools(cq);
      if (otherPools.length > 0) families.push({ name: "Oth", pools: otherPools });

      // The sidebar state is redacted (ordinal `acct-N` ids, no email), so it
      // cannot be matched by email or real id. Its index aligns with the real
      // Antigravity store order, so resolve the real account by index, then the
      // manager alias by the real label. Never assign the main account's alias
      // to every `current` account (that produced duplicate names).
      const idx = /^acct-(\d+)$/.exec(a.id)?.[1];
      const real = idx !== undefined ? realAnti[Number(idx)] : undefined;
      const mgr = real ? antiByLabel.get(real.label) : undefined;
      const label = mgr?.alias || real?.label || a.label || a.id;

      // Which family(ies) this account is the active one for, from the real
      // store's per-family active indices (index-aligned with the sidebar).
      const numIdx = idx !== undefined ? Number(idx) : -1;
      const activeFor = [
        activeFamilies.gemini === numIdx ? "gem" : null,
        activeFamilies.claude === numIdx ? "o" : null,
      ].filter((f): f is string => !!f).join(", ");

      agAccounts.push({
        id: a.id,
        label,
        active: Boolean(a.current),
        activeFor: activeFor || undefined,
        families,
        health: Math.round(clamp(a.health ?? 100, 0, 100)),
      });
    }
  }

  // Active routing summary for Antigravity
  let agRouteSummary = "sticky \u00b7 gemini: antigravity";
  const routes = agState?.activeRouting;
  if (routes && typeof routes === "object") {
    const latest = Object.values(routes).sort((x: any, y: any) => (y.updatedAt ?? 0) - (x.updatedAt ?? 0))[0] as any;
    if (latest) {
      agRouteSummary = `${latest.strategy ? `${latest.strategy} \u00b7 ` : ""}${latest.modelFamily || "gemini"}: ${latest.headerStyle || "antigravity"}`;
    }
  }

  const zenConfigured = isOpencodeConfigured(configDir);
  const zenStatus = zenUsageTracker.getStatus(zenConfigured, "big-pickle");
  const opencodeZen: OpenCodeZenDisplayData = {
    isConfigured: zenConfigured,
    model: zenStatus.model,
    usedPct: zenStatus.usedPct,
    totalTokens24h: zenStatus.totalTokens24h,
    inputTokens24h: zenStatus.inputTokens24h,
    outputTokens24h: zenStatus.outputTokens24h,
    estimatedLimit: zenStatus.estimatedLimit,
    pacing: zenStatus.pacing,
    resetsIn: zenStatus.resetsInFormatted,
    isRateLimited: zenStatus.isRateLimited,
    rateLimitResetFormatted: zenStatus.rateLimitResetFormatted,
    routingMode: cfg.router.routingMode ?? "main-first",
  };

  return {
    routingMode: cfg.router.routingMode ?? "main-first",
    openai: {
      accounts: oaAccounts,
      routingMode: oaRoutingMode,
    },
    chatgptWeb,
    antigravity: {
      accounts: agAccounts,
      routeSummary: agRouteSummary,
    },
    opencodeZen,
  };
}

function getOpenAiSummary(data: UnifiedSidebarData): { name: string; text: string; tone: "ok" | "warn" | "err" | "muted" } {
  const active = data.openai.accounts.find(a => a.active) ?? data.openai.accounts[0];
  if (!active) return { name: "main", text: "\u2014", tone: "muted" };

  const w5h = active.windows.find(w => w.label === "5h");
  const w7d = active.windows.find(w => w.label === "7d");

  let text = "";
  if (w5h && w7d) {
    text = `5h: ${Math.round(w5h.usedPct)}% 7d: ${Math.round(w7d.usedPct)}%`;
  } else if (w5h) {
    text = `5h: ${Math.round(w5h.usedPct)}%`;
  } else if (w7d) {
    text = `7d: ${Math.round(w7d.usedPct)}%`;
  } else {
    text = "ready";
  }

  const maxPct = Math.max(...active.windows.map(w => w.usedPct), 0);
  const tone = maxPct >= 80 ? "err" : maxPct >= 50 ? "warn" : "ok";
  return { name: active.name, text, tone };
}

function getAntigravitySummary(data: UnifiedSidebarData): { name: string; text: string; tone: "ok" | "warn" | "err" | "muted" } {
  const active = data.antigravity.accounts.find(a => a.active) ?? data.antigravity.accounts[0];
  if (!active) return { name: "Account 1", text: "\u2014", tone: "muted" };

  const parts: string[] = [];
  let maxPct = 0;
  for (const fam of active.families) {
    const worst = fam.pools.reduce<AntigravityDisplayPool | null>(
      (best, p) => (best === null || p.usedPct > best.usedPct ? p : best),
      null
    );
    if (worst) {
      parts.push(`${fam.name}: ${Math.round(worst.usedPct)}%`);
      maxPct = Math.max(maxPct, worst.usedPct);
    }
  }

  const text = parts.length > 0 ? parts.join(" \u00b7 ") : "\u2014";
  const tone = maxPct >= 80 ? "err" : maxPct >= 50 ? "warn" : "ok";
  return { name: active.label, text, tone };
}

function getZenSummary(data: UnifiedSidebarData): { name: string; text: string; tone: "ok" | "warn" | "err" | "muted" } {
  const zen = data.opencodeZen;
  if (!zen.isConfigured) return { name: "OpenCode Zen", text: "offline", tone: "muted" };
  const text = `${Math.round(zen.usedPct)}% (${formatTokenCount(zen.totalTokens24h)})`;
  const tone = zen.usedPct >= 80 ? "err" : zen.usedPct >= 50 ? "warn" : "ok";
  return { name: zen.model, text, tone };
}

/**
 * Unified Model Manager Right-Column Sidebar.
 * Accurately replicates CortexKit OpenAI (Image 1) and Antigravity (Image 2)
 * styling, boxes, pacing bars, tags, and routing, with interactive collapse/expand.
 */
export function ModelManagerSidebar(props: { api: Api; sessionId?: string }) {
  const [data, setData] = createSignal<UnifiedSidebarData>(
    gatherSidebarData(undefined, props.sessionId)
  );

  onMount(() => {
    const timer = setInterval(() => {
      setData(gatherSidebarData(undefined, props.sessionId));
    }, 2000);
    onCleanup(() => clearInterval(timer));
  });

  const theme = () => props.api.theme?.current ?? ({} as any);

  const oaSummary = () => getOpenAiSummary(data());
  const agSummary = () => getAntigravitySummary(data());
  const zenSummary = () => getZenSummary(data());

  return (
    <box width="100%" flexDirection="column" gap={0}>
      {/* Top Violet MODEL MANAGER Badge (Click to collapse entire widget) */}
      <box
        width="100%"
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        marginBottom={0}
        onMouseDown={() => toggleManager()}
      >
        <box paddingLeft={1} paddingRight={1} backgroundColor="#a855f7">
          <text fg="#000000">
            <b>{managerCollapsed() ? "\u25b6 MODEL MANAGER" : "\u25bc MODEL MANAGER"}</b>
          </text>
        </box>
      </box>

      {/* When MODEL MANAGER is collapsed: show only the compact active accounts overview */}
      <Show when={managerCollapsed()}>
        <box
          width="100%"
          flexDirection="column"
          border={SINGLE_BORDER}
          borderColor={theme().borderActive ?? theme().border ?? "#444444"}
          paddingTop={0}
          paddingBottom={0}
          paddingLeft={1}
          paddingRight={1}
          marginTop={0}
          onMouseDown={() => toggleManager()}
        >
          <box width="100%" flexDirection="row" justifyContent="space-between">
            <text fg={theme().textMuted ?? "#888888"}>{oaSummary().name}</text>
            <box flexDirection="row">
              <text fg={toneColor(theme(), oaSummary().tone)}>
                <b>{oaSummary().text}</b>
              </text>
              <text fg={toneColor(theme(), oaSummary().tone)}>{" \u25cf"}</text>
            </box>
          </box>
          <box width="100%" flexDirection="row" justifyContent="space-between" marginTop={1}>
            <text fg={theme().textMuted ?? "#888888"}>{agSummary().name}</text>
            <box flexDirection="row">
              <text fg={toneColor(theme(), agSummary().tone)}>
                <b>{agSummary().text}</b>
              </text>
              <text fg={toneColor(theme(), agSummary().tone)}>{" \u25cf"}</text>
            </box>
          </box>
          <Show when={data().opencodeZen.isConfigured}>
            <box width="100%" flexDirection="row" justifyContent="space-between" marginTop={1}>
              <text fg={theme().textMuted ?? "#888888"}>{zenSummary().name}</text>
              <box flexDirection="row">
                <text fg={toneColor(theme(), zenSummary().tone)}>
                  <b>{zenSummary().text}</b>
                </text>
                <text fg={toneColor(theme(), zenSummary().tone)}>{" \u25cf"}</text>
              </box>
            </box>
          </Show>
        </box>
      </Show>

      {/* When MODEL MANAGER is expanded: show OpenAI, Antigravity, and Zen sections */}
      <Show when={!managerCollapsed()}>
        {/* OPENAI PANEL */}
        <box
          width="100%"
          flexDirection="column"
          border={SINGLE_BORDER}
          borderColor="#10a37f"
          paddingTop={0}
          paddingBottom={0}
          paddingLeft={1}
          paddingRight={1}
          marginTop={0}
        >
          {/* Header: Clickable ▼/▶ OPENAI (NO version string) */}
          <box
            width="100%"
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            onMouseDown={() => toggleOpenai()}
          >
            <box paddingLeft={1} paddingRight={1} backgroundColor="#10a37f">
              <text fg="#ffffff">
                <b>{openaiCollapsed() ? "\u25b6 OPENAI" : "\u25bc OPENAI"}</b>
              </text>
            </box>
          </box>

          {/* Collapsed view: active account summary row (Image 1 collapsed) */}
          <Show when={openaiCollapsed()}>
            <box
              width="100%"
              flexDirection="row"
              justifyContent="space-between"
              marginTop={1}
              onMouseDown={() => toggleOpenai()}
            >
              <text fg={theme().textMuted ?? "#888888"}>{oaSummary().name}</text>
              <box flexDirection="row">
                <text fg={toneColor(theme(), oaSummary().tone)}>
                  <b>{oaSummary().text}</b>
                </text>
                <text fg={toneColor(theme(), oaSummary().tone)}>{" \u25cf"}</text>
              </box>
            </box>
          </Show>

          {/* Expanded view: full accounts, bars, pacing, resets, routing */}
          <Show when={!openaiCollapsed()}>
            {/* Accounts start directly (NO "Quota" header) */}
            <For each={data().openai.accounts}>
              {(acct, idx) => (
                <box width="100%" flexDirection="column" marginTop={idx() === 0 ? 1 : 1}>
                  <box width="100%" flexDirection="row" justifyContent="space-between">
                    <text fg={theme().text ?? "#ffffff"}>
                      <b>{acct.name}</b>
                    </text>
                    <text fg={toneColor(theme(), acct.active ? "ok" : "muted")}>
                      <b>{acct.active ? "active" : "idle"}</b>
                    </text>
                  </box>

                  <For each={acct.windows}>
                    {w => {
                      const segments = quotaBarSegments(w.usedPct, 10, w.pacing);
                      const usageTone = w.usedPct >= 80 ? "err" : w.usedPct >= 50 ? "warn" : "ok";
                      const paceLine = () => {
                        const p = w.pacing;
                        if (!p || p.state === "on-pace") return null;
                        const pct = Math.round(Math.abs(p.deltaPercent));
                        if (p.state === "reserve") return `reserve ${pct}% \u00b7 lasts`;
                        return p.runsOutAt
                          ? `deficit ${pct}% \u00b7 out in ${formatReset(p.runsOutAt)}`
                          : `deficit ${pct}% \u00b7 lasts`;
                      };

                      return (
                        <box width="100%" flexDirection="column">
                          <box width="100%" flexDirection="row" justifyContent="space-between">
                            <box flexDirection="row" alignItems="center">
                              <text fg={theme().textMuted ?? "#888888"}>
                                {w.label.padEnd(3)}
                              </text>
                              <box width={10} flexShrink={0} flexDirection="row">
                                <For each={segments}>
                                  {seg => (
                                    <text fg={toneColor(theme(), seg.tone)}>
                                      {seg.text}
                                    </text>
                                  )}
                                </For>
                              </box>
                              <text fg={toneColor(theme(), usageTone)}>
                                {` ${String(Math.round(w.usedPct)).padStart(3)}%`}
                              </text>
                            </box>
                            <Show when={w.reset}>
                              <text fg={theme().textMuted ?? "#888888"}>{w.reset}</text>
                            </Show>
                          </box>

                          <Show when={paceLine()}>
                            <box width="100%" flexDirection="row">
                              <text fg={theme().textMuted ?? "#888888"}>{"   "}</text>
                              <text fg={toneColor(theme(), w.pacing?.state === "deficit" ? "warn" : "muted")}>
                                {paceLine()}
                              </text>
                            </box>
                          </Show>
                        </box>
                      );
                    }}
                  </For>

                  <Show when={acct.resets !== undefined}>
                    <box width="100%" flexDirection="row" justifyContent="space-between">
                      <text fg={theme().textMuted ?? "#888888"}>{"resets"}</text>
                      <text fg={theme().text ?? "#ffffff"}>
                        <b>{String(acct.resets)}</b>
                      </text>
                    </box>
                  </Show>
                </box>
              )}
            </For>

            {/* ChatGPT Web - ONLY if an account exists */}
            <Show when={data().chatgptWeb.exists}>
              <box width="100%" flexDirection="column" marginTop={1}>
                <box width="100%" flexDirection="row" justifyContent="space-between">
                  <text fg={theme().text ?? "#ffffff"}>
                    <b>{data().chatgptWeb.alias ? `[${data().chatgptWeb.alias}] ` : ""}ChatGPT Web</b>
                  </text>
                  <text fg={toneColor(theme(), data().chatgptWeb.isLoggedIn ? "ok" : "muted")}>
                    <b>{data().chatgptWeb.isLoggedIn ? "active" : "idle"}</b>
                  </text>
                </box>
                <box width="100%" flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted ?? "#888888"}>{"Status"}</text>
                  <text fg={theme().text ?? "#ffffff"}>
                    {data().chatgptWeb.tier ? `${data().chatgptWeb.tier} (${data().chatgptWeb.turns} turns)` : "ready"}
                  </text>
                </box>
                <Show when={data().chatgptWeb.reset}>
                  <box width="100%" flexDirection="row" justifyContent="space-between">
                    <text fg={theme().textMuted ?? "#888888"}>{"Reset"}</text>
                    <text fg={theme().textMuted ?? "#888888"}>{data().chatgptWeb.reset}</text>
                  </box>
                </Show>
              </box>
            </Show>

            {/* Routing */}
            <box
              width="100%"
              flexDirection="row"
              justifyContent="space-between"
              alignItems="center"
              marginTop={1}
              onMouseUp={(e: any) => { e.stopPropagation(); e.preventDefault(); openRoutingSelector(props.api, "openai"); }}
            >
              <text fg={theme().text ?? "#ffffff"}>
                <b>{"Routing"}</b>
              </text>
              <text fg="#10a37f">
                <b>{formatRoutingDisplay(data().openai.routingMode)} {"\u25be"}</b>
              </text>
            </box>
          </Show>
        </box>

        {/* GOOGLE PANEL */}
        <box
          width="100%"
          flexDirection="column"
          border={SINGLE_BORDER}
          borderColor="#4285F4"
          paddingTop={0}
          paddingBottom={0}
          paddingLeft={1}
          paddingRight={1}
          marginTop={1}
        >
          {/* Header: Clickable ▼/▶ GOOGLE (NO version string) */}
          <box
            width="100%"
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            onMouseDown={() => toggleAntigravity()}
          >
            <box paddingLeft={1} paddingRight={1} backgroundColor="#4285F4">
              <text fg="#ffffff">
                <b>{antigravityCollapsed() ? "\u25b6 GOOGLE" : "\u25bc GOOGLE"}</b>
              </text>
            </box>
          </box>

          {/* Collapsed view: active account summary row (Image 1 collapsed) */}
          <Show when={antigravityCollapsed()}>
            <box
              width="100%"
              flexDirection="row"
              justifyContent="space-between"
              marginTop={1}
              onMouseDown={() => toggleAntigravity()}
            >
              <text fg={theme().textMuted ?? "#888888"}>{agSummary().name}</text>
              <box flexDirection="row">
                <text fg={toneColor(theme(), agSummary().tone)}>
                  <b>{agSummary().text}</b>
                </text>
                <text fg={toneColor(theme(), agSummary().tone)}>{" \u25cf"}</text>
              </box>
            </box>
          </Show>

          {/* Expanded view: full accounts, Gemini/Other bars, health, routing */}
          <Show when={!antigravityCollapsed()}>
            {/* Accounts start directly (NO "Quota" header) */}
            <For each={data().antigravity.accounts}>
              {(acct, idx) => (
                <box width="100%" flexDirection="column" marginTop={idx() === 0 ? 1 : 1}>
                  <box width="100%" flexDirection="row" justifyContent="space-between">
                    <text fg={theme().text ?? "#ffffff"}>
                      <b>{acct.label}</b>
                    </text>
                    <text fg={toneColor(theme(), acct.active ? "ok" : "muted")}>
                      <b>{acct.active ? `active: ${acct.activeFor || "?"}` : "idle"}</b>
                    </text>
                  </box>

                  <For each={acct.families}>
                    {(fam) => (
                      <For each={fam.pools}>
                        {p => {
                          const segments = quotaBarSegments(p.usedPct, 10);
                          const poolTone = p.usedPct >= 80 ? "err" : p.usedPct >= 50 ? "warn" : "ok";
                          return (
                            <box width="100%" flexDirection="row" justifyContent="space-between">
                              <box flexDirection="row">
                                <text fg="#4285F4">
                                  <b>{fam.name}</b>
                                </text>
                                <text width={4} flexShrink={0} fg={theme().textMuted ?? "#888888"}>
                                  {` ${p.label.padEnd(3)}`}
                                </text>
                                <For each={segments}>
                                  {seg => (
                                    <text fg={toneColor(theme(), seg.tone)}>
                                      {seg.text}
                                    </text>
                                  )}
                                </For>
                                <text fg={toneColor(theme(), poolTone)}>
                                  {` ${String(Math.round(p.usedPct)).padStart(3)}%`}
                                </text>
                              </box>
                              <Show when={p.reset}>
                                <text fg={theme().textMuted ?? "#888888"}>{p.reset}</text>
                              </Show>
                            </box>
                          );
                        }}
                      </For>
                    )}
                  </For>

                  <box width="100%" flexDirection="column">
                    <text fg={theme().textMuted ?? "#888888"}>{`   health ${acct.health}`}</text>
                  </box>
                </box>
              )}
            </For>

            {/* Routing */}
            <box
              width="100%"
              flexDirection="row"
              justifyContent="space-between"
              alignItems="center"
              marginTop={1}
              onMouseUp={(e: any) => { e.stopPropagation(); e.preventDefault(); openRoutingSelector(props.api, "google"); }}
            >
              <text fg={theme().text ?? "#ffffff"}>
                <b>{"Routing"}</b>
              </text>
              <text fg="#4285F4">
                <b>{formatRoutingDisplay(data().antigravity.routeSummary)} {"\u25be"}</b>
              </text>
            </box>
          </Show>
        </box>

        {/* OPENCODE ZEN PANEL */}
        <box
          width="100%"
          flexDirection="column"
          border={SINGLE_BORDER}
          borderColor="#f97316"
          paddingTop={0}
          paddingBottom={0}
          paddingLeft={1}
          paddingRight={1}
          marginTop={1}
        >
          {/* Header: Clickable ▼/▶ OPENCODE ZEN */}
          <box
            width="100%"
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            onMouseDown={() => toggleZen()}
          >
            <box paddingLeft={1} paddingRight={1} backgroundColor="#f97316">
              <text fg="#000000">
                <b>{zenCollapsed() ? "\u25b6 OPENCODE ZEN" : "\u25bc OPENCODE ZEN"}</b>
              </text>
            </box>
          </box>

          {/* Collapsed view */}
          <Show when={zenCollapsed()}>
            <box
              width="100%"
              flexDirection="row"
              justifyContent="space-between"
              marginTop={1}
              onMouseDown={() => toggleZen()}
            >
              <text fg={theme().textMuted ?? "#888888"}>{zenSummary().name}</text>
              <box flexDirection="row">
                <text fg={toneColor(theme(), zenSummary().tone)}>
                  <b>{zenSummary().text}</b>
                </text>
                <text fg={toneColor(theme(), zenSummary().tone)}>{" \u25cf"}</text>
              </box>
            </box>
          </Show>

          {/* Expanded view */}
          <Show when={!zenCollapsed()}>
            <box width="100%" flexDirection="column" marginTop={1}>
              <box width="100%" flexDirection="row" justifyContent="space-between">
                <text fg={theme().text ?? "#ffffff"}>
                  <b>{data().opencodeZen.model}</b>
                </text>
                <text fg={toneColor(theme(), data().opencodeZen.isConfigured ? "ok" : "muted")}>
                  <b>{data().opencodeZen.isConfigured ? (data().opencodeZen.isRateLimited ? "limited" : "active") : "offline"}</b>
                </text>
              </box>

              {(() => {
                const segments = quotaBarSegments(data().opencodeZen.usedPct, 10, data().opencodeZen.pacing);
                const usageTone = data().opencodeZen.usedPct >= 80 ? "err" : data().opencodeZen.usedPct >= 50 ? "warn" : "ok";
                const paceLine = () => {
                  const p = data().opencodeZen.pacing;
                  if (!p || p.state === "on-pace") return null;
                  const pct = Math.round(Math.abs(p.deltaPercent));
                  if (p.state === "reserve") return `reserve ${pct}% \u00b7 lasts`;
                  return p.runsOutAt
                    ? `deficit ${pct}% \u00b7 out in ${formatReset(p.runsOutAt)}`
                    : `deficit ${pct}% \u00b7 lasts`;
                };

                return (
                  <box width="100%" flexDirection="column">
                    <box width="100%" flexDirection="row" justifyContent="space-between">
                      <box flexDirection="row" alignItems="center">
                        <text fg={theme().textMuted ?? "#888888"}>{"24h "}</text>
                        <box width={10} flexShrink={0} flexDirection="row">
                          <For each={segments}>
                            {seg => (
                              <text fg={toneColor(theme(), seg.tone)}>
                                {seg.text}
                              </text>
                            )}
                          </For>
                        </box>
                        <text fg={toneColor(theme(), usageTone)}>
                          {` ${String(Math.round(data().opencodeZen.usedPct)).padStart(3)}%`}
                        </text>
                      </box>
                      <Show when={data().opencodeZen.resetsIn}>
                        <text fg={theme().textMuted ?? "#888888"}>{data().opencodeZen.resetsIn}</text>
                      </Show>
                    </box>

                    <Show when={paceLine()}>
                      <box width="100%" flexDirection="row">
                        <text fg={theme().textMuted ?? "#888888"}>{"    "}</text>
                        <text fg={toneColor(theme(), data().opencodeZen.pacing?.state === "deficit" ? "warn" : "muted")}>
                          {paceLine()}
                        </text>
                      </box>
                    </Show>

                    <box width="100%" flexDirection="row" justifyContent="space-between">
                      <text fg={theme().textMuted ?? "#888888"}>{"tokens"}</text>
                      <text fg={theme().text ?? "#ffffff"}>
                        <b>{`${formatTokenCount(data().opencodeZen.totalTokens24h)} / ${formatTokenCount(data().opencodeZen.estimatedLimit)}`}</b>
                      </text>
                    </box>
                  </box>
                );
              })()}
            </box>

            {/* Routing */}
            <box
              width="100%"
              flexDirection="row"
              justifyContent="space-between"
              alignItems="center"
              marginTop={1}
              onMouseUp={(e: any) => { e.stopPropagation(); e.preventDefault(); openRoutingSelector(props.api, "opencode"); }}
            >
              <text fg={theme().text ?? "#ffffff"}>
                <b>{"Routing"}</b>
              </text>
              <text fg="#f97316">
                <b>{formatRoutingDisplay(data().opencodeZen.routingMode)} {"\u25be"}</b>
              </text>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  );
}
