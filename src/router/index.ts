import type { Config, Hooks } from "@opencode-ai/plugin";
import type { Model as ModelV2 } from "@opencode-ai/sdk/v2";
import type { RouterSettings } from "../manager/types.js";
import { loadConfig, tierTargets } from "../manager/store.js";
import { buildAgentConfig } from "../manager/operations.js";
import { logger } from "../shared/logger.js";

const TIERS = ["fast", "medium", "heavy"] as const;

/** Purpose line for the routing protocol injected into the system prompt. */
function tierPurpose(tier: (typeof TIERS)[number], chain: RouterSettings["tiers"][typeof TIERS[number]]): string {
  const purpose: Record<(typeof TIERS)[number], string> = {
    fast: "read-only exploration and quick searches",
    medium: "implementation and refactoring",
    heavy: "architecture and complex debugging",
  };
  return `@${tier} [tier:${tier}] -> ${chain.model}${chain.variant ? ` (variant ${chain.variant})` : ""}: ${purpose[tier]}`;
}

/** Original compact routing protocol describing tiers, tags and dispatch rules. */
export function routerProtocol(settings: RouterSettings): string {
  const lines = TIERS.map(t => tierPurpose(t, settings.tiers[t]));
  return [
    "## Routing protocol (manager-owned)",
    ...lines,
    "Dispatch rules: the primary NEVER executes directly — every task, including trivial ones, is delegated to a subagent.",
    "Route: @fast for read-only/search, @medium for implementation, @heavy for architecture/debugging.",
    "Do not delegate to the same tier as the current agent (no self-call).",
    "The primary orchestrator (build) owns dispatch and final acceptance.",
  ].join("\n");
}

/** Variant configured for a model across the manager's tier chains (if any). */
function variantForModel(settings: RouterSettings, agent: string, modelID: string): string | undefined {
  if (!(TIERS as readonly string[]).includes(agent)) return undefined;
  const chain = settings.tiers[agent as typeof TIERS[number]];
  if (chain.model === modelID) return chain.variant;
  return tierTargets(chain).find(target => target.model === modelID)?.variant;
}

/**
 * Manager-owned tier routing. When disabled it registers no protocol, tier
 * agents or guard; model fallback may nevertheless continue independently.
 */
export function managerRouterHooks(settings: RouterSettings | undefined): Hooks {
  const s = settings ?? loadConfig().router;
  if (!s.enabled) {
    logger.info("[router] routing disabled via manager settings; no routing hooks registered");
    return {};
  }

  return {
    config: async (cfg: Config) => {
      const agents = buildAgentConfig(s);
      cfg.agent ??= {};
      // Preserve user-authored fields on agents we own (prompt, tools, etc.).
      for (const name of ["build", ...TIERS] as const) {
        const { model: _model, variant: _variant, ...rest } = cfg.agent[name] ?? {};
        cfg.agent[name] = { ...rest, ...agents[name]! };
      }
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(routerProtocol(s));
    },
    "tool.execute.before": async (data, output) => {
      if (data.tool !== "task") return;
      const explicit = String(output.args?.prompt ?? "").match(/\[tier:(fast|medium|heavy)\]/)?.[1];
      if (explicit) output.args.subagent_type = explicit;
      const tier = output.args?.subagent_type as string | undefined;
      if (tier && (TIERS as readonly string[]).includes(tier)) {
        const tag = `[tier:${tier}]`;
        const prompt = String(output.args?.prompt ?? "");
        if (!prompt.includes(tag)) output.args = { ...output.args, prompt: `${tag} ${prompt}`.trim() };
      }
    },
    "chat.params": async (input, output) => {
      // Apply per-model variant options selected for the actual model in use.
      // Only merges the model's own declared variant options (never foreign
      // provider reasoning fields), and only for a manager-known model.
      const model = input.model as ModelV2;
      const modelID = model.id.startsWith(`${model.providerID}/`) ? model.id : `${model.providerID}/${model.id}`;
      const variant = variantForModel(s, input.agent, modelID);
      const opts = variant ? model.variants?.[variant] : undefined;
      if (opts) Object.assign(output.options, opts);
    },
  };
}
