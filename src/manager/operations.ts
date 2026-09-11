import type { Config } from "@opencode-ai/plugin";
import type { ManagerConfig, RouterSettings } from "./types.js";
import { emptyConfig, saveConfig, tierTargets } from "./store.js";

/**
 * Reset the MANAGER configuration + wizard to defaults ONLY.
 * This intentionally does NOT touch provider credentials (cortexkit auth stores,
 * antigravity tokens, or the ChatGPT web bridge state). It is scoped and explicit.
 */
export function resetManager(dir?: string): ManagerConfig {
  const cfg = emptyConfig();
  saveConfig(cfg, dir);
  return cfg;
}

/**
 * Build the flat host agent map (typed to Config['agent']) from the manager's
 * router settings: build orchestrator + fast/medium/heavy subagent tiers, each
 * with a flat model string, optional variant and ordered fallback chain.
 */
export function buildAgentConfig(router: RouterSettings): NonNullable<Config["agent"]> {
  const agents: NonNullable<Config["agent"]> = {
    build: {
      model: router.orchestrator,
      mode: "primary",
      description: "Primary orchestrator",
      fallback_models: [...new Set([router.tiers.heavy.model, ...tierTargets(router.tiers.heavy).map(target => target.model)])].filter(model => model !== router.orchestrator),
    },
  };
  const steps = { fast: 32, medium: 64, heavy: 128 } as const;
  for (const tier of ["fast", "medium", "heavy"] as const) {
    const chain = router.tiers[tier];
    agents[tier] = {
      model: chain.model,
      mode: "subagent",
      description: `${tier} delegation tier (${chain.model})`,
      fallback_models: tierTargets(chain).map(t => t.model),
      steps: steps[tier],
      ...(chain.variant ? { variant: chain.variant } : {}),
    };
  }
  return agents;
}
