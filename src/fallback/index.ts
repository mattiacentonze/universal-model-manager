import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig, tierTargets } from "../manager/store.js";
import fallbackPkg from "./engine.js";

/** Dedupe by exact model, preserving first-occurrence order. */
export function dedupeChain(models: string[]): string[] {
  return [...new Set(models.filter(Boolean))];
}

/** Ordered primary fallback chain from manager settings: tier primary + targets. */
export function managerFallbackChain(): string[] {
  const tiers = loadConfig().router.tiers;
  const chain: string[] = [];
  for (const k of ["heavy", "medium", "fast"] as const) {
    const t = tiers[k];
    chain.push(t.model, ...tierTargets(t).map((x) => x.model));
  }
  return dedupeChain(chain);
}

export const fallbackPlugin: Plugin = async (input, options) => {
  const pluginFn: any = fallbackPkg;
  const chain = managerFallbackChain();
  const cfg = loadConfig();
  const routingMode = cfg.router.routing?.mode ?? cfg.router.routingMode ?? "main-first";
  const hooks = await pluginFn(input, { ...options, fallback_models: chain, routing_mode: routingMode });
  const baseConfig = hooks.config;
  // opencode-runtime-fallback 0.2.4 reads the global chain from its file config,
  // ignoring the factory fallback_models override. Apply the manager chain to any
  // agent without an explicit chain so the configured fallback is honored. The
  // engine reads agentConfigs by reference at error time, so installing the chain
  // before the original config hook registers it is safe.
  hooks.config = (cfg: any) => {
    const agents = cfg?.agent ?? cfg?.agents;
    if (agents && typeof agents === "object") {
      for (const name of Object.keys(agents)) {
        const agent = agents[name];
        if (agent && typeof agent === "object" && !agent.fallback_models) {
          agent.fallback_models = chain;
        }
      }
    }
    baseConfig?.(cfg);
  };
  return hooks;
};

export default {
  id: "universal-runtime-fallback",
  server: fallbackPlugin,
};
