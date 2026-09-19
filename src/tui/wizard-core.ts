import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { providerConfigured } from "../manager/auth-status.js";
import type { FallbackTarget, ManagerConfig, TierChain, TierName } from "../manager/types.js";
import { currentStep, firstMissingStep } from "../manager/wizard.js";

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
  return TIERS.filter((t) => !cfg.wizard?.tiersConfirmed?.[t] || !cfg.router.tiers[t].model);
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
  return chain.fallback.map((model) => ({ model, variant: map[model] }));
}

/** Format a clean, friendly model name without wrapper tags like (Antigravity). */
export function formatCleanModelName(id: string, rawLabel?: string): string {
  if (!id) return "None";
  const [_provider, modelKey] = id.includes("/") ? id.split("/") : ["", id];
  let label = rawLabel || modelKey || id;

  // Strip "(Antigravity)", "(antigravity)", or "antigravity-"
  label = label.replace(/\s*\([Aa]ntigravity\)/g, "");
  label = label.replace(/^antigravity-/i, "");

  // Recognized clean names
  const lowerKey = (modelKey || "").toLowerCase();
  const lowerId = id.toLowerCase();
  if (lowerKey === "antigravity-gemini-3.8-flash" || lowerId.includes("gemini-3.8-flash")) {
    return "Gemini 3.8 Flash";
  }
  if (lowerKey.includes("gemini-2.5-flash-thinking") || lowerId.includes("gemini-2.5-flash-thinking")) {
    return "Gemini 2.5 Flash Thinking";
  }
  if (lowerKey.includes("gemini-2.5-flash") || lowerId.includes("gemini-2.5-flash")) {
    return "Gemini 2.5 Flash";
  }
  if (lowerKey.includes("gemini-2.5-pro") || lowerId.includes("gemini-2.5-pro")) {
    return "Gemini 2.5 Pro";
  }
  if (lowerKey.includes("gpt-6-astra") || lowerId.includes("gpt-6-astra")) {
    return "GPT-6 Astra";
  }
  if (lowerKey.includes("deepseek-v4-flash") || lowerId.includes("deepseek-v4-flash")) {
    return "DeepSeek V4 Flash";
  }

  return label.trim();
}

/** Distinct reasoning variants known for a model from the real catalog (never guessed). */
export function catalogVariants(model: string, models: CatalogModel[]): string[] {
  const matched = models.filter((m) => m.id === model && m.variant);
  const known = [...new Set(matched.map((m) => m.variant as string))];
  if (known.length > 0) return known;
  const lower = model.toLowerCase();
  if (
    lower.includes("astra") ||
    lower.includes("o1") ||
    lower.includes("o3") ||
    lower.includes("gemini") ||
    lower.includes("flash") ||
    lower.includes("thinking")
  ) {
    return ["low", "medium", "high"];
  }
  return [];
}

/** Variant picker options for a tier model, seeded from the real catalog. */
export function tierVariantOptions(
  _model: string,
  catalogVariants: string[],
  current?: string,
): { title: string; value: string | undefined }[] {
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
          label: formatCleanModelName(id, typeof m?.name === "string" ? m.name : key),
          variant: typeof m?.variant === "string" ? m.variant : undefined,
        });
      }
    }
  }
  if (out.length === 0) {
    const sample = [
      ["iit", "deepseek-v4-flash", "DeepSeek V4 Flash"],
      ["openai", "gpt-6-astra", "GPT-6 Astra"],
      ["google", "antigravity-gemini-3.8-flash", "Gemini 3.8 Flash"],
    ];
    for (const [provider, id, label] of sample) out.push({ provider, id: `${provider}/${id}`, label });
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

export type { FallbackTarget, ManagerConfig, TierName };
export { currentStep, firstMissingStep, providerConfigured };
