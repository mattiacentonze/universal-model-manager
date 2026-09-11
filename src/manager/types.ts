/** Provider backends the manager can wire auth for. */
export type ProviderKind = "openai" | "antigravity" | "chatgpt-web";

/** A user-facing account registration for a provider backend. */
export interface AccountEntry {
  /** Stable unique id within the manager (slug). */
  id: string;
  kind: ProviderKind;
  label: string;
  /** Whether the cortexkit/antigravity account is the active main account. */
  main: boolean;
  /** `true` when the underlying auth has completed (valid credentials present). */
  configured: boolean;
}

/** A per-tier model+fallback chain. */
export interface TierChain {
  model: string;
  variant?: string;
  /** Ordered fallback model ids (string form kept for backwards compatibility). */
  fallback: string[];
  /**
   * Optional per-fallback-model reasoning variant, keyed by model id. Lets a
   * chain say "Gemini at medium, DeepSeek with no variant" — impossible with a
   * bare `fallback: string[]`. Runtime fallback merges the variant into the
   * registered agent options when the provider supports it.
   */
  fallbackVariants?: Record<string, string>;
  /** Ordered fallback targets: model id + optional variant (backwards compatible with `fallback`). */
  targets?: FallbackTarget[];
}

export interface RouterSettings {
  orchestrator: string;
  tiers: Record<TierName, TierChain>;
  enabled: boolean;
}

export type TierName = "fast" | "medium" | "heavy";

/** Ordered fallback target for a tier chain: model id + optional reasoning variant. */
export interface FallbackTarget {
  model: string;
  variant?: string;
}

/**
 * Persisted wizard progress, shared by CLI, TUI and server. Each step is only
 * "done" when the user has explicitly confirmed it AND the settings are valid;
 * non-empty defaults are suggestions, never an assertion of completion. Missing
 * steps are therefore derived from these confirmation flags, not a counter.
 * Backwards compatible: `completed` is retained as a legacy summary.
 */
export interface WizardState {
  completed: string[];
  updatedAt: string;
  /** Accounts step: user confirmed their provider choice. */
  accountsConfirmed?: boolean;
  /** Accounts step: user explicitly skipped native auth for an external provider (e.g. IIT). */
  accountsSkipAuth?: boolean;
  /** Per-tier confirmation: a tier is only done once the user confirmed its chain. */
  tiersConfirmed?: Partial<Record<TierName, boolean>>;
  /** Router + orchestrator confirmed. */
  routerConfirmed?: boolean;
}

export interface ManagerConfig {
  version: number;
  accounts: AccountEntry[];
  router: RouterSettings;
  wizard: WizardState | null;
}

export const WIZARD_STEPS = ["accounts", "tiers", "router"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];
