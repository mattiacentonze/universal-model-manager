import type { AccountEntry, FallbackTarget, ManagerConfig, RouterSettings, TierChain, TierName, WizardStep } from "./types.js";
import { firstMissingStep, loadConfig, saveConfig, setTierTargets, TIER_NAMES, isValidModelId } from "./store.js";
import { providerConfigured } from "./auth-status.js";
import { getOpenCodeConfigDir } from "../shared/paths.js";

const nowIso = () => new Date().toISOString();

export function applyTierPatch(base: RouterSettings, patch: Partial<Record<TierName, Partial<TierChain>>>): RouterSettings {
  const tiers = { ...base.tiers };
  for (const tier of TIER_NAMES) {
    const p = patch[tier];
    if (!p) continue;
    let chain: TierChain = {
      ...tiers[tier],
      ...p,
      fallback: p.fallback ?? tiers[tier].fallback,
      fallbackVariants: p.fallbackVariants ?? tiers[tier].fallbackVariants,
    };
    if (p.targets) chain = setTierTargets(chain, p.targets as FallbackTarget[]);
    else if (p.fallback) chain = setTierTargets(chain, mapTargets(chain));
    tiers[tier] = chain;
  }
  return { ...base, tiers };
}

function mapTargets(chain: TierChain): FallbackTarget[] {
  const map = chain.fallbackVariants ?? {};
  return (chain.fallback ?? []).map(model => ({ model, variant: map[model] }));
}

export interface WizardResult {
  cfg: ManagerConfig;
  next: string | null;
  complete: boolean;
}

function ensureWizard(cfg: ManagerConfig) {
  cfg.wizard ??= { completed: [], updatedAt: nowIso() };
  cfg.wizard.updatedAt = nowIso();
}

function markCompleted(cfg: ManagerConfig, step: WizardStep) {
  ensureWizard(cfg);
  if (!cfg.wizard!.completed.includes(step)) cfg.wizard!.completed.push(step);
}

/**
 * Persist a step's confirmed values and return the next missing step.
 * Each successful per-field selection is saved; confirmation is explicit, so a
 * tier is only "done" when its chain is valid AND the user confirmed it.
 */
export function completeStep(step: WizardStep, values: Record<string, unknown>, dir?: string, configDir = getOpenCodeConfigDir()): WizardResult {
  const cfg = loadConfig(dir);
  ensureWizard(cfg);

  if (step === "accounts") {
    if (Array.isArray(values.accounts)) {
      const accounts = (values.accounts as AccountEntry[]).map(a => ({ ...a }));
      for (const kind of ["openai", "antigravity", "chatgpt-web"] as const) {
        const ofKind = accounts.filter(a => a.kind === kind);
        if (ofKind.length > 0) {
          ofKind.forEach(a => (a.main = a === ofKind[0]));
          ofKind[0].main = true;
        }
      }
      cfg.accounts = accounts;
    }
    if (values.accountsSkipAuth === true) cfg.wizard!.accountsSkipAuth = true;
    cfg.wizard!.accountsConfirmed = true;
    markCompleted(cfg, "accounts");
  } else if (step === "tiers") {
    const patch = values as Partial<Record<TierName, Partial<TierChain>>>;
    cfg.router = applyTierPatch(cfg.router, patch);
    ensureWizard(cfg);
    cfg.wizard!.tiersConfirmed ??= {};
    for (const tier of TIER_NAMES) {
      const chain = cfg.router.tiers[tier];
      if (patch[tier] && isValidModelId(chain.model)) cfg.wizard!.tiersConfirmed[tier] = true;
    }
    if (TIER_NAMES.every(t => cfg.wizard!.tiersConfirmed![t])) markCompleted(cfg, "tiers");
  } else if (step === "router") {
    if (typeof values.orchestrator === "string" && isValidModelId(values.orchestrator)) {
      cfg.router = {
        ...cfg.router,
        orchestrator: values.orchestrator,
        enabled: values.enabled !== false,
        ...(typeof values.orchestratorVariant === "string" ? { orchestratorVariant: values.orchestratorVariant } : {}),
        ...(Array.isArray(values.orchestratorFallbacks) ? { orchestratorFallbacks: values.orchestratorFallbacks as string[] } : {}),
      };
      cfg.wizard!.routerConfirmed = true;
      markCompleted(cfg, "router");
    }
  }

  saveConfig(cfg, dir);
  const next = firstMissingStep(cfg, configDir);
  return { cfg, next, complete: next === null };
}

export function currentStep(dir?: string, configDir = getOpenCodeConfigDir()): string | null {
  return firstMissingStep(loadConfig(dir), configDir);
}

export { firstMissingStep };
