import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getOpenCodeConfigDir, getUniversalAuthDataDir } from "../shared/paths.js";
import { loadConfig, saveConfig, defaultParametersForMode } from "./store.js";
import type { UnifiedRoutingConfig, UnifiedRoutingMode, UnifiedRoutingParameters } from "./types.js";
import { findPortFile } from "./quota-poller.js";

export interface GoogleProviderRoutingPayload {
  account_selection_strategy: string;
  scheduling_mode: string;
  switch_on_first_rate_limit: boolean;
  soft_quota_threshold_percent: number;
  proactive_rotation_threshold_percent: number;
  max_account_switches: number;
  max_cache_first_wait_seconds: number;
  pid_offset_enabled: boolean;
}

export interface OpenAIProviderRoutingPayload {
  routing: {
    mode: string;
  };
  switch_on_first_rate_limit?: boolean;
}

export interface ZenProviderRoutingPayload {
  zenRoutingMode: string;
}

/**
 * Static mapping between UnifiedRoutingMode and provider-specific native strategy/mode.
 */
export function mapModeToGoogleStrategy(mode: UnifiedRoutingMode): { account_selection_strategy: string; scheduling_mode: string } {
  switch (mode) {
    case "main-first":
      return { account_selection_strategy: "main-first", scheduling_mode: "cache_first" };
    case "load-balancing":
      return { account_selection_strategy: "round-robin", scheduling_mode: "performance_first" };
    case "latency-based":
      return { account_selection_strategy: "hybrid", scheduling_mode: "balance" };
    case "cost-based":
      return { account_selection_strategy: "hybrid", scheduling_mode: "balance" };
    case "usage-based":
      return { account_selection_strategy: "hybrid", scheduling_mode: "balance" };
  }
}

export function mapModeToOpenAI(mode: UnifiedRoutingMode): string {
  switch (mode) {
    case "main-first":
      return "main-first";
    case "load-balancing":
    case "latency-based":
    case "cost-based":
    case "usage-based":
      return "sticky-balanced";
  }
}

/**
 * Static field-name mapping only. No per-provider value translation.
 */
export function translateToProvider(
  config: UnifiedRoutingConfig,
  provider: "google" | "antigravity" | "openai" | "opencode-zen"
): Record<string, unknown> {
  const { mode, parameters } = config;

  if (provider === "google" || provider === "antigravity") {
    const googleModes = mapModeToGoogleStrategy(mode);
    const payload: GoogleProviderRoutingPayload = {
      account_selection_strategy: googleModes.account_selection_strategy,
      scheduling_mode: googleModes.scheduling_mode,
      switch_on_first_rate_limit: parameters.switchOnFirstRateLimit,
      soft_quota_threshold_percent: parameters.softQuotaThresholdPercent,
      proactive_rotation_threshold_percent: parameters.proactiveRotationThresholdPercent,
      max_account_switches: parameters.maxAccountSwitches,
      max_cache_first_wait_seconds: parameters.maxCacheFirstWaitSeconds,
      pid_offset_enabled: parameters.pidOffsetEnabled,
    };
    return payload as unknown as Record<string, unknown>;
  }

  if (provider === "openai") {
    const oaiMode = mapModeToOpenAI(mode);
    return {
      routing: { mode: oaiMode },
      switch_on_first_rate_limit: parameters.switchOnFirstRateLimit,
    };
  }

  if (provider === "opencode-zen") {
    return {
      zenRoutingMode: mapModeToOpenAI(mode),
    };
  }

  return {};
}

/**
 * Sends a silent RPC command to a running provider auth plugin.
 */
export async function applyRpcCommandSilently(
  provider: "antigravity" | "openai",
  command: string,
  args: string
): Promise<boolean> {
  try {
    const portEntry = await findPortFile(provider);
    if (!portEntry) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${portEntry.port}/rpc/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${portEntry.token}`,
      },
      body: JSON.stringify({ command, arguments: args }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Propagate unified routing configuration to all 3 providers and persist globally.
 */
export async function syncUnifiedRouting(
  api: any,
  mode: UnifiedRoutingMode,
  customParams?: Partial<UnifiedRoutingParameters>
): Promise<void> {
  const parameters: UnifiedRoutingParameters = {
    ...defaultParametersForMode(mode),
    ...(customParams || {}),
  };

  const unifiedConfig: UnifiedRoutingConfig = { mode, parameters };
  const dataDir = getUniversalAuthDataDir();
  const configDir = getOpenCodeConfigDir();

  // 1. Persist to manager.json
  try {
    const mCfg = loadConfig(dataDir, configDir);
    mCfg.router = mCfg.router || ({} as any);
    mCfg.router.routing = unifiedConfig;
    mCfg.router.routingMode = (mode === "main-first" ? "main-first" : "balanced") as any;
    mCfg.router.zenRoutingMode = mapModeToOpenAI(mode) as any;
    saveConfig(mCfg, dataDir);
    if (configDir !== dataDir) {
      try { saveConfig(mCfg, configDir); } catch {}
    }
  } catch (err) {
    api?.ui?.toast({
      variant: "error",
      title: "Routing Error",
      message: `Failed to save manager config: ${String(err)}`,
    });
    return;
  }

  // 2. Persist to Google config (google.json and fallback antigravity.json)
  try {
    const googlePayload = translateToProvider(unifiedConfig, "google");
    const googlePath = join(configDir, "google.json");
    let currentGoogle: Record<string, unknown> = {};
    if (existsSync(googlePath)) {
      try {
        currentGoogle = JSON.parse(readFileSync(googlePath, "utf-8"));
      } catch {}
    }
    const updatedGoogle = { ...currentGoogle, ...googlePayload };
    delete updatedGoogle.routing_mode;
    writeFileSync(googlePath, JSON.stringify(updatedGoogle, null, 2), "utf-8");

    const agPath = join(configDir, "antigravity.json");
    if (existsSync(agPath)) {
      try {
        const agCur = JSON.parse(readFileSync(agPath, "utf-8"));
        const updatedAg = { ...agCur, ...googlePayload };
        delete updatedAg.routing_mode;
        writeFileSync(agPath, JSON.stringify(updatedAg, null, 2), "utf-8");
      } catch {}
    }
  } catch {}

  // 3. Persist to OpenAI config (openai-auth.json)
  try {
    const oaiPayload = translateToProvider(unifiedConfig, "openai");
    const oaiPath = join(configDir, "openai-auth.json");
    let currentOai: Record<string, unknown> = {};
    if (existsSync(oaiPath)) {
      try {
        currentOai = JSON.parse(readFileSync(oaiPath, "utf-8"));
      } catch {}
    }
    const updatedOai = { ...currentOai, ...oaiPayload };
    writeFileSync(oaiPath, JSON.stringify(updatedOai, null, 2), "utf-8");
  } catch {}

  // 4. Hot reload via silent RPC: Antigravity and OpenAI
  const googleStrategy = (translateToProvider(unifiedConfig, "google") as any).account_selection_strategy;
  const oaiStrategy = mapModeToOpenAI(mode);

  await Promise.all([
    applyRpcCommandSilently("antigravity", "antigravity-routing", googleStrategy),
    applyRpcCommandSilently("openai", "openai-routing", oaiStrategy),
  ]);

  api?.ui?.toast({
    variant: "success",
    title: "Unified routing",
    message: `Routing mode updated to ${mode} across all providers.`,
  });
}
