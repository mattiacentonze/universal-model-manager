import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AccountEntry,
  FallbackTarget,
  ManagerConfig,
  RouterRoutingMode,
  RouterSettings,
  TierChain,
  UnifiedRoutingConfig,
  UnifiedRoutingMode,
  UnifiedRoutingParameters,
  WizardState,
} from "./types.js";
import { getUniversalAuthDataDir, getOpenCodeConfigDir } from "../shared/paths.js";
import { providerConfigured, reconcileConfigured } from "./auth-status.js";

export const MANAGER_FILE = "manager.json";
export const MANAGER_VERSION = 1;
export const TIER_NAMES = ["fast", "medium", "heavy"] as const;

export const UNIFIED_ROUTING_MODES: UnifiedRoutingMode[] = [
  "main-first",
  "load-balancing",
  "latency-based",
  "cost-based",
  "usage-based",
];

export const DEFAULT_UNIFIED_ROUTING_PARAMETERS: UnifiedRoutingParameters = {
  softQuotaThresholdPercent: 80,
  proactiveRotationThresholdPercent: 0,
  switchOnFirstRateLimit: false,
  maxAccountSwitches: 10,
  maxCacheFirstWaitSeconds: 60,
  pidOffsetEnabled: false,
  latencyWindowMs: 60000,
  costWindowMs: 86400000,
};

export const DEFAULT_UNIFIED_ROUTING: UnifiedRoutingConfig = {
  mode: "main-first",
  parameters: { ...DEFAULT_UNIFIED_ROUTING_PARAMETERS },
};

export const DEFAULT_CHAIN: TierChain = {
  model: "iit/deepseek-v4-flash",
  fallback: ["google/antigravity-gemini-3.8-flash"],
};

const ASTRA = "openai/gpt-6-astra";
const GEMINI = "google/antigravity-gemini-3.8-flash";
const DEEPSEEK = "iit/deepseek-v4-flash";

/**
 * Router defaults mirror the user's original routing: the build orchestrator and
 * fast tier run on DeepSeek, while medium/heavy run on Astra (medium). These are
 * SUGGESTIONS the wizard asks the user to confirm, never an assertion of
 * completion.
 */
export const DEFAULT_ROUTER: RouterSettings = {
  orchestrator: DEEPSEEK,
  enabled: true,
  routingMode: "main-first",
  tiers: {
    fast: { ...DEFAULT_CHAIN, model: DEEPSEEK, fallback: [GEMINI] },
    medium: {
      model: ASTRA,
      variant: "medium",
      fallback: [GEMINI, DEEPSEEK],
      fallbackVariants: { [GEMINI]: "medium" },
    },
    heavy: {
      model: ASTRA,
      variant: "medium",
      fallback: [GEMINI, DEEPSEEK],
      fallbackVariants: { [GEMINI]: "medium" },
    },
  },
};

export const DEFAULT_ACCOUNTS: AccountEntry[] = [
  { id: "openai-main", kind: "openai", label: "OpenAI / ChatGPT", alias: "main", main: true, configured: false },
  { id: "antigravity-main", kind: "antigravity", label: "Google Antigravity", alias: "main", main: false, configured: false },
];

export function emptyConfig(): ManagerConfig {
  return {
    version: MANAGER_VERSION,
    accounts: DEFAULT_ACCOUNTS.map(a => ({ ...a })),
    router: structuredClone(DEFAULT_ROUTER),
    wizard: null,
  };
}

/** A model identifier must be provider/model with both sides non-empty. */
export function isValidModelId(s: unknown): s is string {
  return typeof s === "string" && /^[^/]+\/[^/]+$/.test(s) && s.length > 1;
}

function isValidTarget(t: unknown): t is FallbackTarget {
  if (typeof t !== "object" || t === null) return false;
  const o = t as Record<string, unknown>;
  if (!isValidModelId(o.model)) return false;
  if (o.variant !== undefined && typeof o.variant !== "string") return false;
  if (o.alias !== undefined && typeof o.alias !== "string") return false;
  return true;
}

function noDupsAndNoPrimaryCycle(targets: FallbackTarget[], primary: string): boolean {
  const models = targets.map(t => t.model);
  return models.length === new Set(models).size && !models.includes(primary);
}

export function isTierChain(v: unknown): v is TierChain {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  // `model` may be empty while the wizard saves intermediate/partial state, but
  // any provided non-empty identifier must be a valid provider/model.
  if (typeof c.model !== "string") return false;
  if (c.model !== "" && !isValidModelId(c.model)) return false;
  if (c.variant !== undefined && typeof c.variant !== "string") return false;
  if (!Array.isArray(c.fallback) || !c.fallback.every(f => isValidModelId(f))) return false;
  // The legacy fallback list itself must avoid duplicates and primary cycles.
  if (new Set(c.fallback).size !== c.fallback.length) return false;
  if (c.model !== "" && c.fallback.includes(c.model)) return false;
  if (c.targets !== undefined) {
    if (!Array.isArray(c.targets) || !c.targets.every(isValidTarget)) return false;
    if (!noDupsAndNoPrimaryCycle(c.targets as FallbackTarget[], c.model)) return false;
    const fromTargets = new Map((c.targets as FallbackTarget[]).map(t => [t.model, t.variant]));
    if (!c.fallback.every(f => fromTargets.has(f))) return false;
  }
  if (c.fallbackVariants !== undefined) {
    if (typeof c.fallbackVariants !== "object" || c.fallbackVariants === null) return false;
    const fv = c.fallbackVariants as Record<string, unknown>;
    if (Object.values(fv).some(v => typeof v !== "string")) return false;
    if (!Object.keys(fv).every(k => (c.fallback as string[]).includes(k))) return false;
  }
  return true;
}

function isRouter(v: unknown): v is RouterSettings {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.orchestrator !== "string") return false;
  if (r.orchestrator !== "" && !isValidModelId(r.orchestrator)) return false;
  if (typeof r.enabled !== "boolean") return false;
  if (r.routingMode !== undefined && !["main-first", "sticky", "sticky-balanced", "fallback-first", "round-robin", "balanced"].includes(String(r.routingMode))) return false;
  if (r.zenRoutingMode !== undefined && !["main-first", "sticky", "sticky-balanced", "fallback-first", "round-robin", "balanced"].includes(String(r.zenRoutingMode))) return false;
  if (r.orchestratorVariant !== undefined && typeof r.orchestratorVariant !== "string") return false;
  if (r.orchestratorFallbacks !== undefined && (!Array.isArray(r.orchestratorFallbacks) || r.orchestratorFallbacks.some(f => typeof f !== "string"))) return false;
  const t = r.tiers as Record<string, unknown> | undefined;
  if (typeof t !== "object" || t === null) return false;
  return TIER_NAMES.every(k => isTierChain(t[k]));
}

function isAccount(v: unknown): v is AccountEntry {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    ["openai", "antigravity", "chatgpt-web", "opencode"].includes(String(a.kind)) &&
    typeof a.label === "string" &&
    (a.alias === undefined || typeof a.alias === "string") &&
    typeof a.main === "boolean" &&
    typeof a.configured === "boolean"
  );
}

function isWizard(v: unknown): v is WizardState {
  if (typeof v !== "object" || v === null) return false;
  const w = v as Record<string, unknown>;
  if (typeof w.updatedAt !== "string") return false;
  if (!Array.isArray(w.completed) || w.completed.some(s => typeof s !== "string")) return false;
  if (w.accountsConfirmed !== undefined && typeof w.accountsConfirmed !== "boolean") return false;
  if (w.accountsSkipAuth !== undefined && typeof w.accountsSkipAuth !== "boolean") return false;
  if (w.routerConfirmed !== undefined && typeof w.routerConfirmed !== "boolean") return false;
  if (w.tiersConfirmed !== undefined) {
    const tc = w.tiersConfirmed as Record<string, unknown>;
    if (typeof tc !== "object" || tc === null) return false;
    if (Object.values(tc).some(v => typeof v !== "boolean")) return false;
  }
  return true;
}

/** Fail-fast check that a parsed input is a valid config shape, else throw. */
export function validateConfig(input: unknown): ManagerConfig {
  if (typeof input !== "object" || input === null) throw new Error("[Manager] Config is not an object");
  const raw = input as Record<string, unknown>;
  if (raw.version !== undefined && raw.version !== MANAGER_VERSION) {
    throw new Error(`[Manager] Unknown config version ${String(raw.version)} (expected ${MANAGER_VERSION}). Refusing to overwrite user data.`);
  }

  const accounts = Array.isArray(raw.accounts) ? raw.accounts.filter(isAccount).map(a => ({ ...a })) : [];
  for (const kind of ["openai", "antigravity", "chatgpt-web", "opencode"] as const) {
    const ofKind = accounts.filter(a => a.kind === kind);
    if (ofKind.length > 0 && !ofKind.some(a => a.main)) ofKind[0].main = true;
  }

  // Router and wizard must be structurally valid; refuse to silently drop them.
  const router = raw.router !== undefined ? raw.router : null;
  if (router === null || !isRouter(router)) {
    throw new Error("[Manager] Invalid or missing router settings. Refusing to overwrite user data.");
  }
  const wizardRaw = raw.wizard;
  if (wizardRaw !== undefined && wizardRaw !== null && !isWizard(wizardRaw)) {
    throw new Error("[Manager] Invalid wizard state. Refusing to overwrite user data.");
  }
  const wizard = isWizard(wizardRaw) ? wizardRaw : null;

  return { version: MANAGER_VERSION, accounts, router, wizard };
}

export function managerDataDir(dir = getUniversalAuthDataDir()): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function managerFilePath(dir = getUniversalAuthDataDir()): string {
  return join(managerDataDir(dir), MANAGER_FILE);
}

/**
 * Load and validate the manager config. Missing file -> fresh defaults; a
 * corrupt or unknown-version file FAILS loudly instead of silently wiping user
 * data so a mistake can never overwrite a real config.
 */
export function loadConfig(dir = getUniversalAuthDataDir(), configDir = getOpenCodeConfigDir()): ManagerConfig {
  const path = managerFilePath(dir);
  let cfg: ManagerConfig;
  if (!existsSync(path)) {
    cfg = emptyConfig();
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`[Manager] Corrupt manager config at ${path}. Refusing to overwrite. Fix or remove the file.`);
    }
    cfg = validateConfig(parsed);
  }
  // `configured` always mirrors the real underlying credential stores.
  cfg.accounts = reconcileConfigured(cfg.accounts, configDir);
  return cfg;
}

/**
 * Persist the manager config atomically. Writes to a unique temp file with
 * owner-only permissions, then renames over the target (the atomic lock that
 * keeps readers from ever seeing a partial write). Refuses to write corrupt or
 * unknown-version data.
 */
export function saveConfig(cfg: ManagerConfig, dir = getUniversalAuthDataDir()): string {
  // Never write a shape we could not read back as the same version.
  const check = validateConfig(JSON.parse(JSON.stringify(cfg)));
  if (check.version !== MANAGER_VERSION) throw new Error("[Manager] Refusing to write unsupported config version.");
  const path = managerFilePath(dir);
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** Migrate a legacy pre-manager file (version absent/0) to the current version. */
export function migrateConfig(dir = getUniversalAuthDataDir()): ManagerConfig {
  const path = managerFilePath(dir);
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw.version === undefined || raw.version === 0) {
      raw.version = MANAGER_VERSION;
      const cfg = validateConfig(raw);
      saveConfig(cfg, dir);
      return cfg;
    }
  }
  return loadConfig(dir);
}

/** Canonical ordered fallback targets for a tier chain (legacy `fallback`+`fallbackVariants` merge). */
export function tierTargets(chain: TierChain): FallbackTarget[] {
  if (chain.targets?.length) return chain.targets.map(t => ({ model: t.model, variant: t.variant, alias: t.alias }));
  const map = chain.fallbackVariants ?? {};
  return chain.fallback.map(model => ({ model, variant: map[model] }));
}

/** Set the canonical ordered fallback targets, keeping legacy fields in sync. */
export function setTierTargets(chain: TierChain, targets: FallbackTarget[]): TierChain {
  const fallback = targets.map(t => t.model);
  const fallbackVariants = Object.fromEntries(targets.filter(t => t.variant).map(t => [t.model, t.variant as string]));
  return { ...chain, targets: targets.map(t => ({ ...t })), fallback, fallbackVariants };
}

function anyProviderConfigured(configDir: string): boolean {
  return (["openai", "antigravity", "chatgpt-web"] as const).some(k => providerConfigured(k, configDir));
}

/** Accounts step: user confirmed AND (any real provider OR explicit external-auth skip). */
export function accountsStepMissing(cfg: ManagerConfig, configDir = getOpenCodeConfigDir()): boolean {
  if (!cfg.wizard?.accountsConfirmed) return true;
  return !anyProviderConfigured(configDir) && !cfg.wizard.accountsSkipAuth;
}

/** Tiers step: any tier not confirmed by the user or with an invalid model. */
export function tiersStepMissing(cfg: ManagerConfig): boolean {
  return TIER_NAMES.some(t => !cfg.wizard?.tiersConfirmed?.[t] || !isValidModelId(cfg.router.tiers[t].model));
}

/** Router step: orchestrator not confirmed or invalid. */
export function routerStepMissing(cfg: ManagerConfig): boolean {
  return !cfg.wizard?.routerConfirmed || !isValidModelId(cfg.router.orchestrator);
}

/** First wizard step that is not yet validly completed (shared CLI/TUI/server). */
export function firstMissingStep(cfg: ManagerConfig, configDir = getOpenCodeConfigDir()): string | null {
  if (accountsStepMissing(cfg, configDir)) return "accounts";
  if (tiersStepMissing(cfg)) return "tiers";
  if (routerStepMissing(cfg)) return "router";
  return null;
}

/** Whether wizard is fully complete (all steps satisfied). */
export function isWizardComplete(cfg: ManagerConfig, configDir = getOpenCodeConfigDir()): boolean {
  return firstMissingStep(cfg, configDir) === null;
}
