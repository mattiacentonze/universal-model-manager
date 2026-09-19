import { getOpenCodeConfigDir } from "../shared/paths.js";
import { countRealAccounts, providerConfigured } from "./auth-status.js";
import { resetManager } from "./operations.js";
import {
  loginActionFor,
  type MutationResult,
  type NativeAction,
  reorderByManagerIds,
  setMainByManagerId,
} from "./provider-accounts.js";
import { firstMissingStep, loadConfig, managerFilePath, migrateConfig, saveConfig, tierTargets } from "./store.js";
import type { AccountEntry, ManagerConfig } from "./types.js";

export interface CommandOutput {
  text: string;
  action?: NativeAction;
}

const KINDS = ["openai", "antigravity", "chatgpt-web"] as const;

/** Ensure at most one `main` per provider overlaps with whatever real accounts exist. */
export function ensureSingleMain(accounts: AccountEntry[]): AccountEntry[] {
  return KINDS.flatMap((kind): AccountEntry[] => {
    const ofKind = accounts.filter((a) => a.kind === kind);
    if (ofKind.length === 0) return ofKind;
    const marked = ofKind.filter((a) => a.main);
    const mainId = marked.length > 0 ? marked[0].id : ofKind[0].id;
    return ofKind.map((a) => ({ ...a, main: a.id === mainId }));
  });
}

function accountLine(a: AccountEntry, real: number): string {
  const live = a.kind === "openai" || a.kind === "antigravity" ? ` (${real} real)` : "";
  return `  ${a.id} [${a.kind}]${a.main ? " (main)" : ""}: ${a.label} — ${a.configured ? "ready" : "pending"}${a.configured ? "" : live}`;
}

/** Display form of a fallback target: alias/provider/model-variant. */
function targetLabel(t: { alias?: string; model: string; variant?: string }): string {
  return `${t.alias ? `${t.alias}/` : ""}${t.model}${t.variant ? `-${t.variant}` : ""}`;
}

function cfgWithConfigDir(dir?: string, configDir = getOpenCodeConfigDir()): ManagerConfig {
  return loadConfig(dir, configDir);
}

/** Convert a mutation result into a terminal CommandOutput, or null to fall through. */
function mutationOutcome(res: MutationResult): CommandOutput | null {
  if (res.kind === "invalid") return { text: res.text };
  if (res.kind === "delegate") return { text: res.text, action: res.action };
  return null;
}

/**
 * Server-side slash command handler. Runs on the OpenCode host and performs
 * real account/config mutations persisted to the manager file.
 */
export async function handleManagerCommand(
  command: string,
  args = "",
  dir?: string,
  configDir = getOpenCodeConfigDir(),
): Promise<CommandOutput | null> {
  const parts = args.trim().split(/\s+/).filter(Boolean);

  switch (command) {
    case "u-reset":
      resetManager(dir);
      return { text: "[Manager] Manager config & wizard reset to defaults. Credentials were NOT touched." };
    case "u-migrate":
      migrateConfig(dir);
      return { text: "[Manager] Migration applied." };
    case "u-status":
    case "universal-status":
    case "u-wizard": {
      const cfg = cfgWithConfigDir(dir, configDir);
      const next = firstMissingStep(cfg, configDir);
      return {
        text:
          next === null
            ? "[Manager] Wizard complete. All providers and settings valid. Use /u-accounts and /u-router to adjust."
            : `[Manager] Wizard resumes at: ${next}. Config: ${managerFilePath(dir)}`,
      };
    }
    case "u-setup": {
      // Explicit provider setup confirmation: prints real underlying status.
      const cfg = cfgWithConfigDir(dir, configDir);
      const o = providerConfigured("openai", configDir);
      const a = providerConfigured("antigravity", configDir);
      return {
        text: `[Manager] OpenAI: ${o ? "configured" : "pending"} | Antigravity: ${a ? "configured" : "pending"} | Wizard: ${firstMissingStep(cfg, configDir) ?? "complete"}`,
      };
    }
    case "u-accounts": {
      const sub = parts[0];
      if (sub === "add") {
        const kind = parts[1] as (typeof KINDS)[number] | undefined;
        if (!kind || !KINDS.includes(kind)) {
          return { text: "[Manager] Usage: /u-accounts add <openai|antigravity|chatgpt-web> [label]" };
        }
        // Do NOT fake `configured`; the account becomes real only after the actual
        // provider login, which this action delegates to the consumer (TUI/CLI).
        return {
          text: `[Manager] Initiated ${kind} login. Complete the native flow, then re-run /u-accounts to see it.`,
          action: loginActionFor(kind),
        };
      }
      if (sub === "main") {
        const id = parts[1];
        if (!id) return { text: "[Manager] Usage: /u-accounts main <account-id>" };
        const res = await setMainByManagerId(configDir, id);
        const out = mutationOutcome(res);
        if (out) return out;
        const next = loadConfig(dir, configDir);
        saveConfig(next, dir);
        return { text: `[Manager] ${id} is now the real main for its provider.` };
      }
      if (sub === "reorder") {
        const order = parts.slice(1);
        if (order.length === 0) return { text: "[Manager] Usage: /u-accounts reorder <id> [id...]" };
        const res = await reorderByManagerIds(configDir, order);
        const out = mutationOutcome(res);
        if (out) return out;
        const next = loadConfig(dir, configDir);
        saveConfig(next, dir);
        return { text: "[Manager] Real provider account order updated." };
      }
      const cfgLive = cfgWithConfigDir(dir, configDir);
      const lines = [
        "Accounts (real provider status):",
        ...cfgLive.accounts.map((a) => accountLine(a, countRealAccounts(a.kind, configDir))),
      ];
      return { text: lines.join("\n") };
    }
    case "u-main": {
      const id = parts[0];
      if (!id) return { text: "[Manager] Usage: /u-main <account-id>" };
      const res = await setMainByManagerId(configDir, id);
      const out = mutationOutcome(res);
      if (out) return out;
      const next = loadConfig(dir, configDir);
      saveConfig(next, dir);
      return { text: `[Manager] ${id} is now the real main for its provider.` };
    }
    case "u-router": {
      const cfg = cfgWithConfigDir(dir, configDir);
      const sub = parts[0];
      if (sub === "enable" || sub === "disable") {
        cfg.router = { ...cfg.router, enabled: sub === "enable" };
        saveConfig(cfg, dir);
        return { text: `[Manager] Router ${sub}d.` };
      }
      if (sub === "orchestrator") {
        const model = parts[1];
        if (!model) return { text: "[Manager] Usage: /u-router orchestrator <provider/model>" };
        cfg.router = { ...cfg.router, orchestrator: model };
        saveConfig(cfg, dir);
        return { text: `[Manager] Orchestrator set to ${model}.` };
      }
      if (sub === "tier") {
        const tier = parts[1] as "fast" | "medium" | "heavy";
        const model = parts[2];
        if (!["fast", "medium", "heavy"].includes(tier) || !model) {
          return { text: "[Manager] Usage: /u-router tier <fast|medium|heavy> <model> [variant] [fallback,...]" };
        }
        const variant = parts[3];
        const fallback = (parts[4] || "").split(",").filter(Boolean);
        cfg.router.tiers[tier] = {
          model,
          variant: variant && variant.trim() !== "-" ? variant : undefined,
          fallback: fallback.length ? fallback : cfg.router.tiers[tier].fallback,
        };
        saveConfig(cfg, dir);
        return {
          text: `[Manager] ${tier} chain set to ${model}${variant ? ` (${variant})` : ""} -> ${fallback.join(", ")}.`,
        };
      }
      const lines = [
        `Router: ${cfg.router.enabled ? "enabled" : "disabled"} | orchestrator: ${cfg.router.orchestrator}`,
        ...(["fast", "medium", "heavy"] as const).map((t) => {
          const c = cfg.router.tiers[t];
          return `  ${t}: ${c.model}${c.variant ? ` (${c.variant})` : ""} -> ${tierTargets(c).map(targetLabel).join(", ") || "-"}`;
        }),
      ];
      return { text: lines.join("\n") };
    }
    case "u-fallbacks": {
      const cfg = cfgWithConfigDir(dir, configDir);
      const lines = ["Per-tier fallback chains:"];
      for (const t of ["fast", "medium", "heavy"] as const) {
        lines.push(`  ${t}: ${tierTargets(cfg.router.tiers[t]).map(targetLabel).join(", ") || "-"}`);
      }
      return { text: lines.join("\n") };
    }
    default:
      return null;
  }
}

/** Summary text for the sidebar / status. */
export function summarize(cfg: ManagerConfig, configDir = getOpenCodeConfigDir()): string {
  const next = firstMissingStep(cfg, configDir);
  const lines = [
    "Model Manager",
    ...cfg.accounts.map((a) => accountLine(a, countRealAccounts(a.kind, configDir))),
    ...(["fast", "medium", "heavy"] as const).map((t) => {
      const c = cfg.router.tiers[t];
      return `  ${t}: ${c.model}${c.variant ? ` (${c.variant})` : ""} -> ${tierTargets(c).map(targetLabel).join(", ") || "-"}`;
    }),
    `  Wizard: ${next === null ? "complete" : `resume @${next}`}`,
  ];
  return lines.join("\n");
}
