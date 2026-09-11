import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig, tierTargets } from "../manager/store.js";
// @ts-ignore
import fallbackPkg from "opencode-runtime-fallback";

/** Ordered primary fallback chain from manager settings (main default chain). */
function managerFallbackChain(): string[] {
  const tiers = loadConfig().router.tiers;
  const chain: string[] = [];
  for (const k of ["heavy", "medium", "fast"] as const) for (const t of tierTargets(tiers[k])) chain.push(t.model);
  return chain;
}

export const fallbackPlugin: Plugin = async (input, options) => {
  const pkg: any = fallbackPkg;
  const pluginFn = typeof pkg === "function" ? pkg : pkg?.default;
  if (typeof pluginFn !== "function") {
    throw new Error("Could not initialize runtime fallback engine from opencode-runtime-fallback");
  }
  // Pass the deterministic manager default chain via the factory overrides so
  // per-agent fallback_models (registered by the config hook) target the same
  // selected models, instead of a stray global big-pickle default.
  return pluginFn(input, { ...options, fallback_models: managerFallbackChain() });
};

export default {
  id: "universal-runtime-fallback",
  server: fallbackPlugin,
};
