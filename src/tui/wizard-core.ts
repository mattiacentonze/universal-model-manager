import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { FallbackTarget, ManagerConfig, TierChain, TierName } from "../manager/types.js";
import { providerConfigured } from "../manager/auth-status.js";
import { currentStep, firstMissingStep } from "../manager/wizard.js";
import { getAccounts } from "../manager/provider-accounts.js";

export const TIERS: readonly TierName[] = ["fast", "medium", "heavy"] as const;

type WStep = "accounts" | "tiers" | "router";

/** A concrete resolvable model id (provider/model). */
export interface CatalogModel {
  provider: string;
  id: string; // "provider/model"
  label: string;
  variant?: string;
}

/**
 * Ordered list of wizard steps still genuinely missing (TUI-side resume order).
 * Shares the canonical `firstMissingStep` so CLI, TUI and server agree: every
 * step requires explicit user confirmation plus settings validity — non-empty
 * defaults are never asserted as done.
 */
export function remainingSteps(cfg: ManagerConfig, configDir: string): WStep[] {
  const first = firstMissingStep(cfg, configDir);
  if (first === null) return [];
  const order: WStep[] = ["accounts", "tiers", "router"];
  return order.slice(order.indexOf(first as WStep));
}

/** First missing TUI step (no skipping; tiers resume at the first gap). */
export function nextMissingStep(cfg: ManagerConfig, configDir: string): WStep | null {
  return firstMissingStep(cfg, configDir) as WStep | null;
}

/** Ordered selection of tiers still needing confirmation or a valid model. */
export function missingTiers(cfg: ManagerConfig): TierName[] {
  return TIERS.filter(t => !cfg.wizard?.tiersConfirmed?.[t] || !cfg.router.tiers[t].model);
}

/** A tier is configured when it is confirmed and has a valid model. */
export function tierComplete(cfg: ManagerConfig, tier: TierName): boolean {
  const chain = cfg.router.tiers[tier];
  return !!cfg.wizard?.tiersConfirmed?.[tier] && chain.model.length > 0;
}

/** Canonical ordered fallback targets for display/editing. */
export function chainTargets(chain: TierChain): FallbackTarget[] {
  if (chain.targets?.length) return chain.targets;
  const map = chain.fallbackVariants ?? {};
  return chain.fallback.map(model => ({ model, variant: map[model] }));
}

/** Distinct reasoning variants known for a model from the real catalog (never guessed). */
export function catalogVariants(model: string, models: CatalogModel[]): string[] {
  const matched = models.filter(m => m.id === model && m.variant);
  return [...new Set(matched.map(m => m.variant as string))];
}

/** Variant picker options for a tier model, seeded from the real catalog. */
export function tierVariantOptions(model: string, catalogVariants: string[], current?: string): { title: string; value: string | undefined }[] {
  const out: { title: string; value: string | undefined }[] = [];
  if (current) out.push({ title: `Current: ${current}`, value: current });
  out.push({ title: "Default (no variant)", value: undefined });
  for (const v of catalogVariants) {
    if (v !== current) out.push({ title: v, value: v });
  }
  return out;
}

/**
 * Resolve the model catalog from the real `api.state.provider` list. NO
 * hardcoded fake models when the catalog exists; a deterministic sample is only
 * used when the host exposes no provider models (testability without a backend).
 */
export function catalogModels(api: TuiPluginApi): CatalogModel[] {
  const out: CatalogModel[] = [];
  const providers = api?.state?.provider;
  if (Array.isArray(providers) && providers.length > 0) {
    for (const p of providers) {
      const models = p?.models;
      if (!models) continue;
      for (const key of Object.keys(models)) {
        const m = models[key];
        const id = `${p.id}/${key}`;
        out.push({
          provider: p.id,
          id,
          label: typeof m?.name === "string" ? m.name : key,
          variant: typeof m?.variant === "string" ? m.variant : undefined,
        });
      }
    }
  }
  if (out.length === 0) {
    const sample = [
      ["iit", "deepseek-v4-flash"],
      ["openai", "gpt-6-astra"],
      ["google", "antigravity-gemini-3.8-flash"],
    ];
    for (const [provider, id] of sample) out.push({ provider, id: `${provider}/${id}`, label: id });
  }
  return out;
}

/** Human label for a wizard step. */
export function stepLabel(step: string | null): string {
  if (step === "accounts") return "Provider accounts";
  if (step === "tiers") return "Model/variant/tier chains";
  if (step === "router") return "Router + orchestrator";
  return "Complete";
}

export { currentStep, firstMissingStep, providerConfigured };
export type { ManagerConfig, TierName };
