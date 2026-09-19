import { existsSync } from "node:fs";
import type { Catalog } from "../router/catalog.js";
import { findOrphanedStrongPatterns, validateModels } from "../router/catalog.js";
import type { RouterConfig } from "../router/config.js";
import {
  findProjectOverride,
  invalidateConfigCache,
  loadConfig,
  localOverridePath,
  overridePath,
  resolvePresetName,
  writeState,
} from "../router/config.js";
import { resolveEnforcementMode } from "../router/enforcement.js";
import {
  buildBudgetList,
  buildBudgetSwitched,
  buildBypassMessage,
  buildEnforceSet,
  buildEnforceStatus,
  buildModelsOutput,
  buildNoModes,
  buildOverridesOutput,
  buildPresetList,
  buildPresetSwitched,
  buildRouterHelp,
  buildTiersOutput,
  buildUnknownMode,
  buildUnknownPreset,
  formatModelIssues,
} from "./output.js";

export function saveActivePreset(presetName: string): void {
  const cfg = loadConfig();
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) {
    return;
  }

  cfg.activePreset = resolved;

  // Persist user-selected preset to state file only — never mutate tiers.json
  writeState({ activePreset: resolved });

  // Invalidate cache so next read picks up the new active preset
  invalidateConfigCache();
}

export function saveActiveMode(modeName: string): void {
  const cfg = loadConfig();
  if (!cfg.modes?.[modeName]) {
    return;
  }

  cfg.activeMode = modeName;
  writeState({ activeMode: modeName });
  invalidateConfigCache();
}

export function saveEnforcementMode(mode: "off" | "advisory" | "enforced"): void {
  writeState({ enforcementMode: mode });
  invalidateConfigCache();
}

/**
 * `/router` dispatch. Decides and persists here; rendering lives in
 * src/commands/output.ts.
 */
export function buildRouterOutput(cfg: RouterConfig, args: string, env: NodeJS.ProcessEnv = process.env): string {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();

  if (sub === "enforce") {
    const mode = (tokens[1] ?? "").toLowerCase();
    if (mode === "off" || mode === "advisory" || mode === "enforced") {
      saveEnforcementMode(mode);
      return buildEnforceSet(mode);
    }
    return buildEnforceStatus(resolveEnforcementMode({ config: cfg, env }).mode);
  }

  if (sub === "overrides") {
    const globalPath = overridePath();
    const foundLocal = findProjectOverride();
    const localPath = foundLocal ?? localOverridePath();
    return buildOverridesOutput({
      globalPath,
      globalPresent: existsSync(globalPath),
      localPath,
      localPresent: existsSync(localPath),
      localFound: foundLocal !== undefined,
      activePreset: cfg.activePreset,
    });
  }

  return buildRouterHelp(resolveEnforcementMode({ config: cfg, env }).mode);
}

/** `/budget` dispatch. Persists the switch, then renders. */
export function buildBudgetOutput(cfg: RouterConfig, args: string): string {
  const modes = cfg.modes;
  if (!modes || Object.keys(modes).length === 0) return buildNoModes();

  const requested = args.trim().toLowerCase();
  if (!requested) return buildBudgetList(cfg);

  const mode = modes[requested];
  if (mode) {
    saveActiveMode(requested);
    return buildBudgetSwitched(mode, requested);
  }

  return buildUnknownMode(modes, requested);
}

/** `/preset` dispatch. Persists the switch, then renders. */
export function buildPresetOutput(cfg: RouterConfig, args: string): string {
  const requestedPreset = args.trim();
  if (!requestedPreset) return buildPresetList(cfg);

  const resolvedPreset = resolvePresetName(cfg, requestedPreset);
  if (resolvedPreset) {
    saveActivePreset(resolvedPreset);
    cfg.activePreset = resolvedPreset;
    return buildPresetSwitched(cfg, resolvedPreset);
  }

  return buildUnknownPreset(cfg, requestedPreset);
}

export interface CommandDispatchDeps {
  getConfig: () => RouterConfig;
  getBypassed: () => boolean;
  setBypassed: (bypassed: boolean) => void;
  fetchCatalog: () => Promise<Catalog | null>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Centralized router command dispatcher.
 * Handles /tiers, /preset, /bypass, /budget, and /router commands.
 * Returns the output markdown string, or null if the command is not handled.
 */
export async function dispatchRouterCommand(
  command: string,
  args: string,
  deps: CommandDispatchDeps,
): Promise<string | null> {
  const env = deps.env ?? process.env;

  if (command === "tiers") {
    const cfg = deps.getConfig();
    return buildTiersOutput(cfg);
  }

  if (command === "preset") {
    const cfg = deps.getConfig();
    return buildPresetOutput(cfg, args);
  }

  if (command === "bypass") {
    const arg = (args ?? "").trim().toLowerCase();
    let bypassed: boolean;
    if (arg === "on") {
      bypassed = true;
    } else if (arg === "off") {
      bypassed = false;
    } else {
      bypassed = !deps.getBypassed();
    }
    deps.setBypassed(bypassed);
    return buildBypassMessage(bypassed);
  }

  if (command === "budget") {
    const cfg = deps.getConfig();
    return buildBudgetOutput(cfg, args);
  }

  if (command === "router") {
    const cfg = deps.getConfig();
    const trimmed = (args ?? "").trim();
    const parts = trimmed.split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? "").toLowerCase();

    if (sub === "models") {
      const catalog = await deps.fetchCatalog();
      const orphans = catalog ? findOrphanedStrongPatterns(cfg, catalog) : [];
      return buildModelsOutput(catalog, parts.slice(1).join(" "), orphans);
    }

    let text = buildRouterOutput(cfg, trimmed, env);
    // On the bare status view, surface stale or missing models inline.
    if (sub === "") {
      const catalog = await deps.fetchCatalog();
      if (catalog) {
        const issues = validateModels(cfg, catalog);
        if (issues.length > 0) {
          text += `\n\n${formatModelIssues(issues)}`;
        }
      }
    }
    return text;
  }

  return null;
}
