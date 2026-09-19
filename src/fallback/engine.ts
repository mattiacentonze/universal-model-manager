// Vendored from opencode-runtime-fallback 0.2.4 (MIT). Self-contained engine.
// @bun
import { telemetry } from "../telemetry/index.js";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse as parseJsonc } from "jsonc-parser";
import type { PluginInput, Hooks } from "@opencode-ai/plugin";

// types.ts
export interface FallbackConfig {
  enabled: boolean;
  retry_on_errors: number[];
  retryable_error_patterns: string[];
  max_fallback_attempts: number;
  cooldown_seconds: number;
  timeout_seconds: number;
  notify_on_fallback: boolean;
  routing_mode: string;
  fallback_models: string[];
}

export type FallbackConfigOverrides = Partial<FallbackConfig>;

export interface FallbackState {
  originalModel: string;
  currentModel: string;
  fallbackIndex: number;
  failedModels: Map<string, number>;
  attemptCount: number;
  modelRetryCount: number;
  pendingFallbackModel: string | undefined;
}

export interface FallbackPlanSuccess {
  success: true;
  newModel: string;
  failedModel: string;
  newFallbackIndex: number;
}

export interface FallbackPlanFailure {
  success: false;
  error: string;
  maxAttemptsReached?: boolean;
}

export type FallbackPlan = FallbackPlanSuccess | FallbackPlanFailure;

export interface AgentConfig {
  model?: string;
  fallback_models?: string[] | string;
  [key: string]: unknown;
}

export type AgentConfigs = Record<string, AgentConfig>;

export interface EngineDeps {
  ctx: PluginInput;
  readonly config: FallbackConfig;
  readonly agentConfigs: AgentConfigs | undefined;
  globalFallbackModels: string[];
  sessionStates: Map<string, FallbackState>;
  sessionLastAccess: Map<string, number>;
  sessionRetryInFlight: Set<string>;
  sessionAwaitingFallbackResult: Set<string>;
  sessionFallbackTimeouts: Map<string, ReturnType<typeof setTimeout>>;
  sessionFirstTokenReceived: Map<string, boolean>;
  sessionSelfAbortTimestamp: Map<string, number>;
  sessionParentID: Map<string, string | null>;
  sessionIdleResolvers: Map<string, (() => void)[]>;
  sessionLastMessageTime: Map<string, number>;
  sessionLastMessageModel: Map<string, string>;
  sessionCompactionInFlight: Set<string>;
}

export interface ReplayPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ReplayResultSuccess {
  success: true;
  tier: number;
  sentParts: ReplayPart[];
  droppedTypes: string[];
}

export interface ReplayResultFailure {
  success: false;
  error: string;
}

export type ReplayResult = ReplayResultSuccess | ReplayResultFailure;

export interface AutoRetryHelpers {
  getParentSessionID: (sessionID: string) => Promise<string | null>;
  abortSessionRequest: (sessionID: string, source: string) => Promise<void>;
  clearSessionFallbackTimeout: (sessionID: string) => void;
  scheduleSessionFallbackTimeout: (sessionID: string, resolvedAgent: string | undefined) => void;
  autoRetryWithFallback: (
    sessionID: string,
    newModel: string,
    resolvedAgent: string | undefined,
    source: string,
    plan: FallbackPlanSuccess | undefined
  ) => Promise<boolean>;
  resolveAgentForSessionFromContext: (sessionID: string, eventAgent: string | undefined) => Promise<string | undefined>;
  cleanupStaleSessions: () => void;
  findFirstAgentModel: () => string | undefined;
  getOrCreateFallbackState: (
    sessionID: string,
    options?: {
      preferredModel?: string;
      resolvedAgent?: string;
      allowFirstAgentFallback?: boolean;
    }
  ) => FallbackState | undefined;
  notifyFallback: (options: {
    title?: string;
    message?: string;
    newModel: string;
    attemptCount?: number;
    totalFallbackModels?: number;
    prefixMessage?: string;
    immediate?: boolean;
  }) => void;
  notifyExhausted: (options: {
    totalFallbackModels: number;
    attemptCount?: number;
  }) => Promise<void>;
  notifyRecovered: (model: string) => void;
}

// constants.ts
const PLUGIN_NAME = "opencode-fallback";
const DEFAULT_CONFIG: FallbackConfig = {
  enabled: true,
  retry_on_errors: [401, 402, 429, 500, 502, 503, 504],
  retryable_error_patterns: [],
  max_fallback_attempts: 5,
  cooldown_seconds: 60,
  timeout_seconds: 30,
  notify_on_fallback: true,
  routing_mode: "main-first",
  fallback_models: []
};
const RETRYABLE_ERROR_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /quota.?exceeded/i,
  /quota.?protection/i,
  /key.?limit.?exceeded/i,
  /usage\s+limit\s+has\s+been\s+reached/i,
  /service.?unavailable/i,
  /overloaded/i,
  /temporarily.?unavailable/i,
  /try.?again/i,
  /credit.*balance.*too.*low/i,
  /insufficient.?(?:credits?|funds?|balance)/i,
  /(?:^|\s)429(?:\s|$)/,
  /(?:^|\s)503(?:\s|$)/,
  /(?:^|\s)529(?:\s|$)/
];

// logger.ts
const LOG_FILE = join(homedir(), ".config", "opencode", "opencode-fallback.log");
try {
  mkdirSync(join(homedir(), ".config", "opencode"), { recursive: true });
} catch {}
function writeToFile(level: string, message: string, context?: unknown): void {
  const timestamp = new Date().toISOString();
  const contextStr = context ? ` ${JSON.stringify(context)}` : "";
  const logLine = `[${timestamp}] [${level}] [${PLUGIN_NAME}] ${message}${contextStr}\n`;
  try {
    appendFileSync(LOG_FILE, logLine);
  } catch {}
}
const DEBUG_MODE = false;
function logInfo(message: string, context?: unknown): void {
  if (DEBUG_MODE) {
    const contextStr = context ? ` ${JSON.stringify(context)}` : "";
    console.log(`[${PLUGIN_NAME}] ${message}${contextStr}`);
  }
  writeToFile("INFO", message, context);
}
function logError(message: string, context?: unknown): void {
  if (DEBUG_MODE) {
    const contextStr = context ? ` ${JSON.stringify(context)}` : "";
    console.error(`[${PLUGIN_NAME}] ${message}${contextStr}`);
  }
  writeToFile("ERROR", message, context);
}

// config-reader.ts
const SESSION_ID_NOISE_WORDS = new Set(["ses", "work", "task", "session"]);
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeFallbackModelsField(value: unknown): string[] {
  if (!value)
    return [];
  if (typeof value === "string")
    return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}
function readFallbackModels(agentName: string, agents?: AgentConfigs): string[] {
  if (!agents)
    return [];
  const agentConfig = agents[agentName];
  if (!isRecord(agentConfig))
    return [];
  return normalizeFallbackModelsField(agentConfig.fallback_models);
}
function resolveAgentForSession(sessionID: string, eventAgent?: string): string | undefined {
  if (eventAgent && eventAgent.trim().length > 0) {
    return eventAgent.trim().toLowerCase();
  }
  const segments = sessionID.split(/[\s_\-/]+/).filter(Boolean);
  for (const segment of segments) {
    const candidate = segment.toLowerCase();
    const isAlphaOnly = /^[a-z][a-z-]*$/.test(candidate);
    if (candidate.length > 2 && isAlphaOnly && !SESSION_ID_NOISE_WORDS.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
function getFallbackModelsForSession(
  sessionID: string,
  eventAgent: string | undefined,
  agents: AgentConfigs | undefined,
  globalFallbackModels: string[]
): string[] {
  const resolvedAgent = resolveAgentForSession(sessionID, eventAgent);
  if (resolvedAgent && agents) {
    const models = readFallbackModels(resolvedAgent, agents);
    if (models.length > 0) {
      const agentConfig = agents[resolvedAgent];
      if (isRecord(agentConfig) && typeof agentConfig.model === "string") {
        const primaryModel = agentConfig.model;
        if (!models.includes(primaryModel)) {
          models.unshift(primaryModel);
        }
      }
      return models;
    }
  }
  if (globalFallbackModels && globalFallbackModels.length > 0) {
    return globalFallbackModels;
  }
  return [];
}

// fallback-state.ts
const MAX_MODEL_RETRIES = 5;
function createFallbackState(originalModel: string): FallbackState {
  return {
    originalModel,
    currentModel: originalModel,
    fallbackIndex: -1,
    failedModels: new Map(),
    attemptCount: 0,
    modelRetryCount: 0,
    pendingFallbackModel: undefined
  };
}
function isModelInCooldown(model: string, state: FallbackState, cooldownSeconds: number): boolean {
  const failedAt = state.failedModels.get(model);
  if (failedAt === undefined)
    return false;
  const cooldownMs = cooldownSeconds * 1000;
  return Date.now() - failedAt < cooldownMs;
}
function findNextAvailableFallback(
  state: FallbackState,
  fallbackModels: string[],
  cooldownSeconds: number,
  routingMode = "main-first"
): string | undefined {
  const scan = (from: number, to: number): string | undefined => {
    for (let i = from; i < to; i++) {
      const candidate = fallbackModels[i];
      if (candidate === state.currentModel) {
        logInfo(`Skipping fallback model identical to current: ${candidate} (index ${i})`);
        continue;
      }
      if (!isModelInCooldown(candidate, state, cooldownSeconds)) {
        return candidate;
      }
      logInfo(`Skipping fallback model in cooldown: ${candidate} (index ${i})`);
    }
    return undefined;
  };
  const start = state.fallbackIndex + 1;
  if (routingMode === "balanced" || routingMode === "sticky-balanced" || routingMode === "load-balancing" || routingMode === "usage-based") {
    const available: { candidate: string; lastFailed: number; index: number }[] = [];
    for (let i = 0; i < fallbackModels.length; i++) {
      const candidate = fallbackModels[i];
      if (candidate === state.currentModel) continue;
      if (!isModelInCooldown(candidate, state, cooldownSeconds)) {
        const lastFailed = state.failedModels.get(candidate) ?? 0;
        available.push({ candidate, lastFailed, index: i });
      }
    }
    if (available.length > 0) {
      available.sort((a, b) => {
        if (a.lastFailed === 0 && b.lastFailed > 0) return -1;
        if (a.lastFailed > 0 && b.lastFailed === 0) return 1;
        if (a.lastFailed !== b.lastFailed) return a.lastFailed - b.lastFailed;
        return a.index - b.index;
      });
      return available[0].candidate;
    }
    return undefined;
  }
  if (routingMode === "latency-based") {
    const available: { candidate: string; avgLat: number; lastFailed: number; index: number }[] = [];
    for (let i = 0; i < fallbackModels.length; i++) {
      const candidate = fallbackModels[i];
      if (candidate === state.currentModel) continue;
      if (!isModelInCooldown(candidate, state, cooldownSeconds)) {
        const avgLat = telemetry.latency.getAverageLatency(candidate) || 999999;
        const lastFailed = state.failedModels.get(candidate) ?? 0;
        available.push({ candidate, avgLat, lastFailed, index: i });
      }
    }
    if (available.length > 0) {
      available.sort((a, b) => {
        if (a.avgLat !== b.avgLat) return a.avgLat - b.avgLat;
        if (a.lastFailed !== b.lastFailed) return a.lastFailed - b.lastFailed;
        return a.index - b.index;
      });
      return available[0].candidate;
    }
    return undefined;
  }
  if (routingMode === "cost-based") {
    const available: { candidate: string; cost: number; lastFailed: number; index: number }[] = [];
    for (let i = 0; i < fallbackModels.length; i++) {
      const candidate = fallbackModels[i];
      if (candidate === state.currentModel) continue;
      if (!isModelInCooldown(candidate, state, cooldownSeconds)) {
        const cost = telemetry.cost.getAccumulatedCost(candidate);
        const lastFailed = state.failedModels.get(candidate) ?? 0;
        available.push({ candidate, cost, lastFailed, index: i });
      }
    }
    if (available.length > 0) {
      available.sort((a, b) => {
        if (a.cost !== b.cost) return a.cost - b.cost;
        if (a.lastFailed !== b.lastFailed) return a.lastFailed - b.lastFailed;
        return a.index - b.index;
      });
      return available[0].candidate;
    }
    return undefined;
  }
  if (routingMode === "sticky") {
    return scan(start, fallbackModels.length);
  }
  if (routingMode === "fallback-first") {
    const forward = scan(start, fallbackModels.length);
    if (forward !== undefined) {
      return forward;
    }
    const secondary = scan(1, start);
    if (secondary !== undefined) {
      return secondary;
    }
    return scan(0, 1);
  }
  const forward = scan(start, fallbackModels.length);
  if (forward !== undefined) {
    return forward;
  }
  logInfo(`No forward fallback available; wrapping around to retry the whole order`);
  return scan(0, start);
}
function applyFallbackPlan(state: FallbackState, plan: FallbackPlanSuccess, pendingFallbackModel?: string): void {
  state.fallbackIndex = plan.newFallbackIndex;
  state.failedModels.set(plan.failedModel, Date.now());
  state.attemptCount++;
  state.currentModel = plan.newModel;
  state.modelRetryCount = 0;
  state.pendingFallbackModel = pendingFallbackModel;
}
function planFallback(
  sessionID: string,
  state: FallbackState,
  fallbackModels: string[],
  config: FallbackConfig
): FallbackPlan {
  if (state.attemptCount >= config.max_fallback_attempts) {
    logInfo(`Max fallback attempts reached for session ${sessionID} (${state.attemptCount})`);
    return {
      success: false,
      error: "Max fallback attempts reached",
      maxAttemptsReached: true
    };
  }
  const nextModel = findNextAvailableFallback(state, fallbackModels, config.cooldown_seconds, config.routing_mode);
  if (!nextModel) {
    logInfo(`No available fallback models for session ${sessionID}`);
    return {
      success: false,
      error: "No available fallback models (all in cooldown or exhausted)"
    };
  }
  logInfo(`Planned fallback for session ${sessionID}: ${state.currentModel} -> ${nextModel} (will be attempt ${state.attemptCount + 1})`);
  return {
    success: true,
    newModel: nextModel,
    failedModel: state.currentModel,
    newFallbackIndex: fallbackModels.indexOf(nextModel)
  };
}
function commitFallback(state: FallbackState, plan: FallbackPlanSuccess): boolean {
  if (state.currentModel !== plan.failedModel) {
    return false;
  }
  applyFallbackPlan(state, plan);
  return true;
}
function recoverToOriginal(state: FallbackState, cooldownSeconds: number): boolean {
  if (state.currentModel === state.originalModel)
    return false;
  if (isModelInCooldown(state.originalModel, state, cooldownSeconds))
    return false;
  state.currentModel = state.originalModel;
  state.fallbackIndex = -1;
  state.attemptCount = 0;
  state.modelRetryCount = 0;
  state.pendingFallbackModel = undefined;
  return true;
}

// message-replay.ts
const TIER_2_TYPES = new Set(["text", "image"]);
function filterPartsByTier(parts: ReplayPart[], tier: number): ReplayPart[] {
  switch (tier) {
    case 1:
      return parts;
    case 2:
      return parts.filter((p) => TIER_2_TYPES.has(p.type));
    case 3:
      return parts.filter((p) => p.type === "text");
    default:
      return parts;
  }
}
async function replayWithDegradation(
  allParts: ReplayPart[],
  sendFn: (parts: ReplayPart[]) => Promise<void>
): Promise<ReplayResult> {
  if (allParts.length === 0) {
    return { success: false, error: "No parts to replay" };
  }
  const tiers = [1, 2, 3];
  let lastError: unknown;
  let previousLength = -1;
  for (const tier of tiers) {
    const filtered = filterPartsByTier(allParts, tier);
    if (filtered.length === 0)
      continue;
    if (filtered.length === previousLength)
      continue;
    previousLength = filtered.length;
    try {
      await sendFn(filtered);
      const sentTypes = new Set(filtered.map((p) => p.type));
      const allTypes = new Set(allParts.map((p) => p.type));
      const droppedTypes = [...allTypes].filter((t) => !sentTypes.has(t));
      return {
        success: true,
        tier,
        sentParts: filtered,
        droppedTypes
      };
    } catch (err) {
      lastError = err;
    }
  }
  return {
    success: false,
    error: lastError instanceof Error ? lastError.message : String(lastError)
  };
}

// auto-retry.ts
const SESSION_TTL_MS = 30 * 60 * 1000;
const POST_ABORT_DELAY_MS = 150;
function summarizeParts(parts?: ReplayPart[]): { count: number; types: string[]; textChars: number; hasToolCall: boolean } {
  if (!parts || parts.length === 0) {
    return { count: 0, types: [], textChars: 0, hasToolCall: false };
  }
  const typeSet = new Set<string>();
  let textChars = 0;
  let hasToolCall = false;
  for (const part of parts) {
    typeSet.add(part.type);
    const textValue = part.text;
    if (part.type === "text" && typeof textValue === "string") {
      textChars += textValue.length;
    }
    if (part.type === "tool_call") {
      hasToolCall = true;
    }
  }
  return {
    count: parts.length,
    types: Array.from(typeSet),
    textChars,
    hasToolCall
  };
}
function createAutoRetryHelpers(deps: EngineDeps): AutoRetryHelpers {
  const {
    ctx,
    config,
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult,
    sessionFallbackTimeouts
  } = deps;

  const findFirstAgentModel = (): string | undefined => {
    if (!deps.agentConfigs)
      return undefined;
    for (const agentName of Object.keys(deps.agentConfigs)) {
      const agentConfig = deps.agentConfigs[agentName];
      const model = agentConfig?.model;
      if (model)
        return model;
    }
    return undefined;
  };

  const getOrCreateFallbackState = (
    sessionID: string,
    options?: {
      preferredModel?: string;
      resolvedAgent?: string;
      allowFirstAgentFallback?: boolean;
    }
  ): FallbackState | undefined => {
    let state = sessionStates.get(sessionID);
    if (!state) {
      let initialModel = options?.preferredModel;
      if (!initialModel && options?.resolvedAgent && deps.agentConfigs) {
        const agentConfig = deps.agentConfigs[options.resolvedAgent];
        initialModel = agentConfig?.model;
      }
      if (!initialModel && options?.allowFirstAgentFallback) {
        initialModel = findFirstAgentModel();
      }
      if (!initialModel) {
        return undefined;
      }
      state = createFallbackState(initialModel);
      sessionStates.set(sessionID, state);
    }
    sessionLastAccess.set(sessionID, Date.now());
    return state;
  };

  const notifyFallback = (options: {
    title?: string;
    message?: string;
    newModel: string;
    attemptCount?: number;
    totalFallbackModels?: number;
    prefixMessage?: string;
    immediate?: boolean;
  }): void => {
    if (!config.notify_on_fallback) return;
    const modelName = options.newModel.split("/").pop() || options.newModel;
    let message = options.message;
    if (!message) {
      if (options.prefixMessage) {
        const suffix = options.attemptCount !== undefined && options.totalFallbackModels !== undefined
          ? ` (attempt ${options.attemptCount} of ${options.totalFallbackModels})`
          : options.immediate
          ? " (immediate fallback)"
          : "";
        message = `${options.prefixMessage} -> ${modelName}${suffix}`;
      } else if (options.attemptCount !== undefined && options.totalFallbackModels !== undefined) {
        message = `Switching to ${modelName} (attempt ${options.attemptCount} of ${options.totalFallbackModels})`;
      } else {
        message = `Switching to ${modelName} for next request`;
      }
    }
    ctx.client.tui.showToast({
      body: {
        title: options.title || "Model Fallback",
        message,
        variant: "warning",
        duration: 5000
      }
    }).catch(() => {});
  };

  const notifyExhausted = async (options: {
    totalFallbackModels: number;
    attemptCount?: number;
  }): Promise<void> => {
    if (!config.notify_on_fallback) return;
    const attemptsSuffix = options.attemptCount !== undefined ? ` after ${options.attemptCount} attempts` : "";
    await ctx.client.tui.showToast({
      body: {
        title: "All Fallbacks Exhausted",
        variant: "error",
        duration: 8000,
        message: `All ${options.totalFallbackModels} fallback models exhausted${attemptsSuffix}`
      }
    }).catch(() => {});
  };

  const notifyRecovered = (model: string): void => {
    if (!config.notify_on_fallback) return;
    const modelName = model.split("/").pop() || model;
    ctx.client.tui.showToast({
      body: {
        title: "Model Recovered",
        message: `Recovered to ${modelName}`,
        variant: "info",
        duration: 3000
      }
    }).catch(() => {});
  };

  const getParentSessionID = async (sessionID: string): Promise<string | null> => {
    const cached = deps.sessionParentID.get(sessionID);
    if (cached !== undefined)
      return cached;
    try {
      const sessionInfo: any = await ctx.client.session.get({ path: { id: sessionID } });
      const sessionData = sessionInfo?.data ?? sessionInfo;
      const parentID = typeof sessionData?.parentID === "string" && sessionData.parentID.length > 0 ? sessionData.parentID : null;
      deps.sessionParentID.set(sessionID, parentID);
      if (parentID) {
        logInfo("Detected child session", { sessionID, parentID });
      }
      return parentID;
    } catch {
      logError("Failed to look up parentID", { sessionID });
      return null;
    }
  };
  const abortSessionRequest = async (sessionID: string, source: string): Promise<void> => {
    try {
      await ctx.client.session.abort({ path: { id: sessionID } });
      deps.sessionSelfAbortTimestamp.set(sessionID, Date.now());
      logInfo(`Aborted in-flight session request (${source})`, { sessionID });
    } catch (error) {
      logError(`Failed to abort in-flight session request (${source})`, {
        sessionID,
        error: String(error)
      });
    }
  };
  const clearSessionFallbackTimeout = (sessionID: string): void => {
    const timer = sessionFallbackTimeouts.get(sessionID);
    if (timer) {
      clearTimeout(timer);
      sessionFallbackTimeouts.delete(sessionID);
    }
  };
  const scheduleSessionFallbackTimeout = (sessionID: string, resolvedAgent: string | undefined): void => {
    clearSessionFallbackTimeout(sessionID);
    const timeoutMs = config.timeout_seconds * 1000;
    if (timeoutMs <= 0)
      return;
    const timer = setTimeout(async () => {
      sessionFallbackTimeouts.delete(sessionID);
      if (deps.sessionFirstTokenReceived.get(sessionID)) {
        logInfo("Timeout fired but first token already received, skipping abort", {
          sessionID
        });
        return;
      }
      const state = sessionStates.get(sessionID);
      if (!state)
        return;
      if (sessionRetryInFlight.has(sessionID)) {
        logInfo("Timeout fired but retry already in flight, deferring", { sessionID });
        return;
      }
      deps.sessionCompactionInFlight.delete(sessionID);
      await abortSessionRequest(sessionID, "session.timeout");
      if (state.pendingFallbackModel) {
        state.pendingFallbackModel = undefined;
      }
      const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, deps.agentConfigs, deps.globalFallbackModels);
      if (fallbackModels.length === 0)
        return;
      logInfo("Session fallback timeout reached", {
        sessionID,
        timeoutSeconds: config.timeout_seconds,
        currentModel: state.currentModel
      });
      sessionRetryInFlight.add(sessionID);
      try {
        const plan = planFallback(sessionID, state, fallbackModels, config);
        if (plan.success) {
          await autoRetryWithFallback(sessionID, plan.newModel, resolvedAgent, "session.timeout", plan);
        }
      } finally {
        sessionRetryInFlight.delete(sessionID);
      }
    }, timeoutMs);
    sessionFallbackTimeouts.set(sessionID, timer);
  };
  const autoRetryWithFallback = async (
    sessionID: string,
    newModel: string,
    resolvedAgent: string | undefined,
    source: string,
    plan: FallbackPlanSuccess | undefined
  ): Promise<boolean> => {
    let deferredToOtherHandler = false;
    const preCheckState = sessionStates.get(sessionID);
    if (plan) {
      if (preCheckState && preCheckState.currentModel !== plan.failedModel) {
        logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${preCheckState.currentModel}, expected failed model ${plan.failedModel}`, {
          sessionID,
          staleModel: newModel,
          currentModel: preCheckState.currentModel
        });
        deferredToOtherHandler = true;
        return false;
      }
    } else if (preCheckState && preCheckState.currentModel !== newModel) {
      logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${preCheckState.currentModel}, wanted ${newModel}`, {
        sessionID,
        staleModel: newModel,
        currentModel: preCheckState.currentModel
      });
      deferredToOtherHandler = true;
      return false;
    }
    const modelParts = newModel.split("/");
    if (modelParts.length < 2) {
      logInfo(`Invalid model format (missing provider prefix): ${newModel}`);
      const state = sessionStates.get(sessionID);
      if (state?.pendingFallbackModel) {
        state.pendingFallbackModel = undefined;
      }
      return false;
    }
    const fallbackModelObj = {
      providerID: modelParts[0],
      modelID: modelParts.slice(1).join("/")
    };
    const modelAlreadyStopped = source === "session.error" || source === "message.updated";
    const callerAlreadyAborted = source === "session.timeout";
    const mayHaveRecentAbort = source === "session.idle.silent-failure";
    if (modelAlreadyStopped) {
      logInfo(`Skipping abort \u2014 model already stopped (${source})`, {
        sessionID,
        newModel
      });
    } else if (callerAlreadyAborted || mayHaveRecentAbort) {
      const selfAbortTs = deps.sessionSelfAbortTimestamp.get(sessionID);
      const msSinceAbort = selfAbortTs ? Date.now() - selfAbortTs : undefined;
      if (selfAbortTs && msSinceAbort !== undefined && msSinceAbort < POST_ABORT_DELAY_MS * 2) {
        logInfo(`Waiting for recent abort propagation (${source})`, {
          sessionID,
          msSinceAbort
        });
        const remainingMs = Math.max(0, POST_ABORT_DELAY_MS - msSinceAbort);
        if (remainingMs > 0) {
          await new Promise<void>((resolve) => setTimeout(() => resolve(), remainingMs));
        }
      } else if (callerAlreadyAborted) {
        logInfo(`Caller already aborted (${source}), waiting for propagation`, {
          sessionID
        });
        await new Promise<void>((resolve) => setTimeout(() => resolve(), POST_ABORT_DELAY_MS));
      }
    } else {
      await abortSessionRequest(sessionID, `pre-fallback.${source}`);
      await new Promise<void>((resolve) => setTimeout(() => resolve(), POST_ABORT_DELAY_MS));
    }
    deps.sessionFirstTokenReceived.set(sessionID, false);
    let retryDispatched = false;
    try {
      if (resolvedAgent === "compaction") {
        const failedModel = plan?.failedModel;
        logInfo(`Compaction fallback: abort + summarize on fallback (${source})`, {
          sessionID,
          failedModel,
          newModel
        });
        deps.sessionCompactionInFlight.add(sessionID);
        if (failedModel && plan) {
          const currentState = sessionStates.get(sessionID);
          if (currentState) {
            if (!currentState.failedModels.has(failedModel)) {
              currentState.failedModels.set(failedModel, Date.now());
            }
          }
        }
        try {
          await abortSessionRequest(sessionID, "compaction-fallback");
        } catch {
          logError(`Failed to abort session for compaction fallback (${source})`, { sessionID });
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        try {
          const messagesResp: any = await ctx.client.session.messages({
            path: { id: sessionID },
            query: { directory: ctx.directory }
          });
          const msgs: any[] = messagesResp.data ?? [];
          const deleteIDs: string[] = [];
          for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i];
            const msgRole = msg.info?.role;
            const msgError = msg.info?.error;
            const msgID = msg.info?.id;
            const parts = msg.parts ?? [];
            const isCompactionMsg = parts.length > 0 && parts.every((p: any) => p.type === "compaction");
            if (!msgID)
              continue;
            if (msgRole === "assistant" && msgError) {
              deleteIDs.push(msgID);
              continue;
            }
            if (isCompactionMsg) {
              deleteIDs.push(msgID);
              break;
            }
          }
          const rawClient = (ctx.client.session as any)?._client;
          if (rawClient && deleteIDs.length > 0) {
            for (const msgID of deleteIDs) {
              logInfo(`Deleting compaction message (${source})`, {
                sessionID,
                messageID: msgID
              });
              try {
                await rawClient.delete({
                  url: "/session/{id}/message/{messageID}",
                  path: { id: sessionID, messageID: msgID }
                });
                logInfo(`Deleted compaction message (${source})`, {
                  sessionID,
                  messageID: msgID
                });
              } catch (delErr) {
                logError(`Failed to delete compaction message (${source})`, {
                  sessionID,
                  messageID: msgID,
                  error: String(delErr)
                });
              }
            }
          } else if (deleteIDs.length > 0) {
            logError(`Cannot access raw SDK client for message deletion (${source})`, {
              sessionID,
              messageCount: deleteIDs.length
            });
          }
        } catch (msgErr) {
          logError(`Failed during compaction message cleanup (${source})`, {
            sessionID,
            error: String(msgErr)
          });
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        try {
          if (sessionAwaitingFallbackResult.has(sessionID)) {
            logInfo(`Skipping duplicate compaction summarize (${source})`, { sessionID });
            deferredToOtherHandler = true;
            return false;
          }
          sessionAwaitingFallbackResult.add(sessionID);
          logInfo(`Dispatching session.summarize on fallback model (${source})`, {
            sessionID,
            providerID: fallbackModelObj.providerID,
            modelID: fallbackModelObj.modelID
          });
          const summarizeResult = await ctx.client.session.summarize({
            path: { id: sessionID },
            body: {
              providerID: fallbackModelObj.providerID,
              modelID: fallbackModelObj.modelID
            },
            query: { directory: ctx.directory }
          });
          logInfo(`session.summarize response (${source})`, {
            sessionID,
            model: newModel,
            response: (JSON.stringify(summarizeResult) ?? "undefined").slice(0, 500)
          });
          if (plan) {
            const stateToCommit = sessionStates.get(sessionID);
            if (stateToCommit) {
              const committed = commitFallback(stateToCommit, plan);
              if (committed) {
                logInfo(`Committed fallback after compaction summarize (${source})`, {
                  sessionID,
                  from: plan.failedModel,
                  to: plan.newModel,
                  attemptCount: stateToCommit.attemptCount
                });
              }
            }
          }
          scheduleSessionFallbackTimeout(sessionID, undefined);
          retryDispatched = true;
          if (config.notify_on_fallback) {
            const fromName = (failedModel || "primary").split("/").pop();
            const toName = newModel.split("/").pop() || newModel;
            await ctx.client.tui.showToast({
              body: {
                title: "Compaction Fallback",
                message: `${fromName} failed \u2014 retrying compaction on ${toName}`,
                variant: "warning",
                duration: 5000
              }
            }).catch(() => {});
          }
          logInfo(`Compaction re-dispatched via summarize (${source})`, {
            sessionID,
            model: newModel
          });
          return true;
        } catch (summarizeErr) {
          logError(`session.summarize failed (${source})`, {
            sessionID,
            model: newModel,
            error: String(summarizeErr)
          });
          sessionAwaitingFallbackResult.delete(sessionID);
          if (plan) {
            const currentState = sessionStates.get(sessionID);
            if (currentState) {
              commitFallback(currentState, plan);
              logInfo(`Committed compaction fallback state as last resort (${source})`, {
                sessionID,
                from: plan.failedModel,
                to: plan.newModel
              });
            }
          }
          deps.sessionCompactionInFlight.delete(sessionID);
          clearSessionFallbackTimeout(sessionID);
          sessionAwaitingFallbackResult.delete(sessionID);
          if (config.notify_on_fallback) {
            const fromName = (failedModel || "primary").split("/").pop();
            const toName = newModel.split("/").pop() || newModel;
            await ctx.client.tui.showToast({
              body: {
                title: "Compaction Failed",
                message: `${fromName} can't compact \u2014 try /compact after switching to ${toName}`,
                variant: "warning",
                duration: 1e4
              }
            }).catch(() => {});
          }
          deferredToOtherHandler = true;
          return false;
        }
      }
      const messagesResp: any = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory }
      });
      const msgs: any[] = messagesResp.data;
      if (!msgs || msgs.length === 0) {
        logError(`No messages found in session for auto-retry (${source})`, { sessionID });
      }
      let lastUserPartsRaw: any[] | undefined;
      let lastNonAssistantPartsRaw: any[] | undefined;
      for (let i = (msgs?.length ?? 0) - 1; i >= 0; i--) {
        const m = msgs?.[i];
        const role = (m?.info?.role ?? m?.role ?? "").toLowerCase();
        const parts = m?.parts ?? m?.info?.parts;
        if (!parts || parts.length === 0)
          continue;
        const hasOnlyCompactionParts = parts.every((p: any) => p.type === "compaction");
        if (hasOnlyCompactionParts)
          continue;
        if (!lastNonAssistantPartsRaw && role !== "assistant") {
          lastNonAssistantPartsRaw = parts;
        }
        if (role === "user") {
          lastUserPartsRaw = parts;
          break;
        }
      }
      const replayPartsRaw = lastUserPartsRaw ?? lastNonAssistantPartsRaw;
      const replaySource = lastUserPartsRaw ? "last-user" : lastNonAssistantPartsRaw ? "last-non-assistant" : "none";
      if (replayPartsRaw && replayPartsRaw.length > 0) {
        const postCheckState = sessionStates.get(sessionID);
        const expectedCurrentModel = plan ? plan.failedModel : newModel;
        if (postCheckState && postCheckState.currentModel !== expectedCurrentModel) {
          logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${postCheckState.currentModel}, expected failed model ${expectedCurrentModel}`, {
            sessionID,
            staleModel: newModel,
            currentModel: postCheckState.currentModel
          });
          deferredToOtherHandler = true;
          return false;
        }
        if (sessionAwaitingFallbackResult.has(sessionID)) {
          logInfo(`Skipping duplicate fallback dispatch \u2014 another handler already dispatched (${source})`, {
            sessionID,
            model: newModel
          });
          deferredToOtherHandler = true;
          return false;
        }
        sessionAwaitingFallbackResult.add(sessionID);
        logInfo(`Auto-retrying with fallback model (${source})`, {
          sessionID,
          model: newModel,
          agent: resolvedAgent,
          replaySource
        });
        const allParts: ReplayPart[] = replayPartsRaw.filter((p: any) => typeof p.type === "string" && p.type !== "compaction");
        logInfo(`Prepared replay payload (${source})`, {
          sessionID,
          model: newModel,
          agent: resolvedAgent,
          replaySource,
          payload: summarizeParts(allParts)
        });
        if (allParts.length > 0) {
          const sendFn = async (parts: ReplayPart[]): Promise<void> => {
            logInfo(`Dispatching fallback replay (${source})`, {
              sessionID,
              model: newModel,
              agent: resolvedAgent,
              payload: summarizeParts(parts)
            });
            await ctx.client.session.promptAsync({
              path: { id: sessionID },
              body: {
                ...(resolvedAgent ? { agent: resolvedAgent } : {}),
                model: fallbackModelObj,
                parts: parts as any
              },
              query: { directory: ctx.directory }
            });
            logInfo(`Fallback replay accepted by host (${source})`, {
              sessionID,
              model: newModel,
              agent: resolvedAgent
            });
          };
          const replayResult = await replayWithDegradation(allParts, sendFn);
          if (replayResult.success) {
            let commitSucceeded = true;
            if (plan) {
              const stateToCommit = sessionStates.get(sessionID);
              if (stateToCommit) {
                const committed = commitFallback(stateToCommit, plan);
                if (committed) {
                  logInfo(`Committed fallback state after successful dispatch (${source})`, {
                    sessionID,
                    newModel: plan.newModel,
                    failedModel: plan.failedModel,
                    attemptCount: stateToCommit.attemptCount
                  });
                } else {
                  logInfo(`Fallback state already committed by another handler \u2014 aborting duplicate replay (${source})`, {
                    sessionID,
                    newModel: plan.newModel
                  });
                  commitSucceeded = false;
                  await abortSessionRequest(sessionID, `duplicate-replay.${source}`);
                }
              }
            }
            if (!commitSucceeded) {
              deferredToOtherHandler = true;
              return false;
            }
            scheduleSessionFallbackTimeout(sessionID, resolvedAgent);
            retryDispatched = true;
            logInfo(`Fallback replay succeeded (${source})`, {
              sessionID,
              tier: replayResult.tier,
              sentPartsCount: replayResult.sentParts?.length,
              droppedTypes: replayResult.droppedTypes,
              replaySource
            });
            if (replayResult.droppedTypes && replayResult.droppedTypes.length > 0) {
              const droppedStr = replayResult.droppedTypes.join(", ");
              await ctx.client.tui.showToast({
                body: {
                  title: "Message Replay",
                  message: `Some message parts were dropped for compatibility: ${droppedStr}`,
                  variant: "warning",
                  duration: 5000
                }
              }).catch(() => {});
            }
          } else {
            logError(`All replay tiers failed (${source})`, {
              sessionID,
              error: replayResult.error
            });
          }
        }
      } else {
        logInfo(`No replayable non-assistant message found for auto-retry (${source})`, {
          sessionID,
          model: newModel,
          agent: resolvedAgent
        });
      }
    } catch (retryError) {
      logError(`Auto-retry failed (${source})`, {
        sessionID,
        error: String(retryError)
      });
      sessionAwaitingFallbackResult.delete(sessionID);
      deps.sessionCompactionInFlight.delete(sessionID);
      clearSessionFallbackTimeout(sessionID);
    } finally {
      if (!retryDispatched && !deferredToOtherHandler) {
        sessionAwaitingFallbackResult.delete(sessionID);
        deps.sessionCompactionInFlight.delete(sessionID);
        clearSessionFallbackTimeout(sessionID);
        const state = sessionStates.get(sessionID);
        if (state?.pendingFallbackModel) {
          state.pendingFallbackModel = undefined;
        }
      }
    }
    return retryDispatched;
  };
  const resolveAgentForSessionFromContext = async (sessionID: string, eventAgent: string | undefined): Promise<string | undefined> => {
    const resolved = resolveAgentForSession(sessionID, eventAgent);
    if (resolved)
      return resolved;
    try {
      const messagesResp: any = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory }
      });
      const msgs: any[] = messagesResp.data;
      if (!msgs || msgs.length === 0)
        return undefined;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const info = msgs[i]?.info;
        const infoAgent = typeof info?.agent === "string" ? info.agent : undefined;
        if (infoAgent && infoAgent.trim().length > 0) {
          return infoAgent.trim().toLowerCase();
        }
      }
    } catch {
      logError("Failed to resolve agent from messages", { sessionID });
    }
    try {
      const sessionInfo: any = await ctx.client.session.get({ path: { id: sessionID } });
      const sessionData = sessionInfo?.data ?? sessionInfo;
      const sdkAgent = typeof sessionData?.agent === "string" ? sessionData.agent : undefined;
      if (sdkAgent && sdkAgent.trim().length > 0) {
        const normalized = sdkAgent.trim().toLowerCase();
        logInfo("Resolved agent from session.get", { sessionID, agent: normalized });
        return normalized;
      }
    } catch {
      logError("Failed to resolve agent from session.get", { sessionID });
    }
    return undefined;
  };
  const cleanupStaleSessions = (): void => {
    const now = Date.now();
    let cleanedCount = 0;
    for (const [sessionID, lastAccess] of sessionLastAccess.entries()) {
      if (now - lastAccess > SESSION_TTL_MS) {
        sessionStates.delete(sessionID);
        sessionLastAccess.delete(sessionID);
        sessionRetryInFlight.delete(sessionID);
        sessionAwaitingFallbackResult.delete(sessionID);
        deps.sessionFirstTokenReceived.delete(sessionID);
        deps.sessionSelfAbortTimestamp.delete(sessionID);
        deps.sessionParentID.delete(sessionID);
        deps.sessionIdleResolvers.delete(sessionID);
        deps.sessionLastMessageTime.delete(sessionID);
        deps.sessionCompactionInFlight.delete(sessionID);
        clearSessionFallbackTimeout(sessionID);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      logInfo(`Cleaned up ${cleanedCount} stale session states`);
    }
  };
  return {
    getParentSessionID,
    abortSessionRequest,
    clearSessionFallbackTimeout,
    scheduleSessionFallbackTimeout,
    autoRetryWithFallback,
    resolveAgentForSessionFromContext,
    cleanupStaleSessions,
    findFirstAgentModel,
    getOrCreateFallbackState,
    notifyFallback,
    notifyExhausted,
    notifyRecovered
  };
}

// error-classifier.ts
function getObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
function normalizeMessage(value: string): string {
  return value.trim().length === 0 ? "" : value.toLowerCase();
}
function getErrorMessage(error: unknown): string {
  if (!error)
    return "";
  if (typeof error === "string")
    return normalizeMessage(error);
  const errorObj = error as Record<string, any>;
  const paths = [
    errorObj.data?.error,
    errorObj.data,
    errorObj.error,
    errorObj
  ];
  for (const obj of paths) {
    const record = getObjectRecord(obj);
    if (!record || !("message" in record))
      continue;
    const rawMessage = record.message;
    if (typeof rawMessage === "string") {
      return normalizeMessage(rawMessage);
    }
  }
  try {
    return normalizeMessage(JSON.stringify(error));
  } catch {
    return "";
  }
}
function extractStatusCode(error: unknown, retryOnErrors?: number[]): number | undefined {
  if (!error)
    return undefined;
  const errorObj = error as Record<string, any>;
  const statusCode = errorObj.statusCode ?? errorObj.status ?? errorObj.data?.statusCode;
  if (typeof statusCode === "number") {
    return statusCode;
  }
  if (typeof statusCode === "string") {
    const parsed = Number.parseInt(statusCode, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  const codes = retryOnErrors ?? DEFAULT_CONFIG.retry_on_errors;
  const message = getErrorMessage(error);
  const contextualPattern = new RegExp(`(?:status(?:\\s+code)?|code|http)D*(${codes.join("|")})\\b|\\b(${codes.join("|")})\\b(?=\x00|[^0-9])`, "i");
  const statusMatch = message.match(contextualPattern);
  const extracted = statusMatch?.[1] ?? statusMatch?.[2];
  if (extracted) {
    return parseInt(extracted, 10);
  }
  return undefined;
}
function extractErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object")
    return undefined;
  const errorObj = error as Record<string, any>;
  const directName = errorObj.name;
  if (typeof directName === "string" && directName.length > 0) {
    return directName;
  }
  const nestedError = errorObj.error;
  const nestedName = nestedError?.name;
  if (typeof nestedName === "string" && nestedName.length > 0) {
    return nestedName;
  }
  const dataError = errorObj.data?.error;
  const dataErrorName = dataError?.name;
  if (typeof dataErrorName === "string" && dataErrorName.length > 0) {
    return dataErrorName;
  }
  return undefined;
}
function classifyErrorType(error: unknown): string | undefined {
  const message = getErrorMessage(error);
  const errorName = extractErrorName(error)?.toLowerCase();
  if (errorName?.includes("loadapi") || /api.?key.?is.?missing/i.test(message) && /environment variable/i.test(message) || /(?:x-api-key|api key).*(?:is required|missing|required)/i.test(message) || /(?:missing|required).*(?:x-api-key|api key)/i.test(message)) {
    return "missing_api_key";
  }
  if (/api.?key/i.test(message) && /must be a string/i.test(message) || /incorrect api key provided/i.test(message) || /api key not valid/i.test(message) || /invalid api key/i.test(message)) {
    return "invalid_api_key";
  }
  if (errorName?.includes("unknownerror") && /model\s+not\s+found/i.test(message)) {
    return "model_not_found";
  }
  if (/model\s+(?:is\s+)?not\s+(?:found|supported|available)/i.test(message) || /the model .+ does not exist/i.test(message)) {
    return "model_not_found";
  }
  return undefined;
}
const AUTO_RETRY_PATTERNS = [
  (combined: string) => /retrying\s+in/i.test(combined),
  (combined: string) => /(?:too\s+many\s+requests|quota\s*exceeded|usage\s+limit|rate\s+limit|limit\s+reached)/i.test(combined)
];
function extractAutoRetrySignal(info: any): { signal: string } | undefined {
  if (!info)
    return undefined;
  const candidates: string[] = [];
  const directStatus = info.status;
  if (typeof directStatus === "string")
    candidates.push(directStatus);
  const summary = info.summary;
  if (typeof summary === "string")
    candidates.push(summary);
  const message = info.message;
  if (typeof message === "string")
    candidates.push(message);
  const details = info.details;
  if (typeof details === "string")
    candidates.push(details);
  const combined = candidates.join("\n");
  if (!combined)
    return undefined;
  const isAutoRetry = AUTO_RETRY_PATTERNS.every((test) => test(combined));
  if (isAutoRetry) {
    return { signal: combined };
  }
  return undefined;
}
function containsErrorContent(parts?: any[]): { hasError: boolean; errorMessage?: string } {
  if (!parts || parts.length === 0)
    return { hasError: false };
  const errorParts = parts.filter((p) => p.type === "error");
  if (errorParts.length > 0) {
    const errorMessages = errorParts.map((p) => p.text).filter((text): text is string => typeof text === "string");
    const errorMessage = errorMessages.length > 0 ? errorMessages.join("\n") : undefined;
    return { hasError: true, errorMessage };
  }
  return { hasError: false };
}
function detectErrorInTextParts(parts?: any[]): { hasError: boolean; errorType?: string; errorMessage?: string } {
  if (!parts || parts.length === 0)
    return { hasError: false };
  const textContent = parts.filter((p) => p.type === "text" && typeof p.text === "string" && p.text.length > 0).map((p) => p.text).join("\n");
  if (!textContent)
    return { hasError: false };
  const errorType = classifyErrorType({ message: textContent, name: "TextContent" });
  if (errorType) {
    return { hasError: true, errorType, errorMessage: textContent };
  }
  return { hasError: false };
}
function extractErrorContentFromParts(parts?: any[]): { hasError: boolean; errorMessage?: string } {
  if (!parts || parts.length === 0)
    return { hasError: false };
  const errorParts = parts.filter((p) => p.type === "error" && typeof p.text === "string" && p.text.length > 0);
  if (errorParts.length > 0) {
    const errorMessage = errorParts.map((p) => p.text).join("\n");
    return { hasError: true, errorMessage };
  }
  return { hasError: false };
}
function isRetryableError(error: unknown, retryOnErrors: number[], userPatterns: string[]): boolean {
  const statusCode = extractStatusCode(error, retryOnErrors);
  const message = getErrorMessage(error);
  const errorType = classifyErrorType(error);
  if (errorType === "missing_api_key") {
    return true;
  }
  if (errorType === "model_not_found") {
    return true;
  }
  if (statusCode && retryOnErrors.includes(statusCode)) {
    return true;
  }
  if (RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return true;
  }
  if (userPatterns && userPatterns.length > 0) {
    for (const patternStr of userPatterns) {
      try {
        const re = new RegExp(patternStr, "i");
        if (re.test(message))
          return true;
      } catch {}
    }
  }
  return false;
}

// event-handler.ts
function createEventHandler(deps: EngineDeps, helpers: AutoRetryHelpers): {
  handleEvent: (args: { event: any }) => Promise<void>;
  handleActivity: (sessionID: string, activityModel?: string) => Promise<void>;
} {
  const {
    config,
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult,
    sessionFallbackTimeouts
  } = deps;
  const handleActivity = async (sessionID: string, activityModel?: string): Promise<void> => {
    if (activityModel && sessionAwaitingFallbackResult.has(sessionID)) {
      const state = sessionStates.get(sessionID);
      if (state && state.failedModels.has(activityModel)) {
        logInfo("Ignoring activity from already-failed model", {
          sessionID,
          activityModel,
          currentModel: state.currentModel
        });
        return;
      }
    }
    if (!deps.sessionFirstTokenReceived.get(sessionID)) {
      deps.sessionFirstTokenReceived.set(sessionID, true);
    }
    if (sessionAwaitingFallbackResult.has(sessionID)) {
      const resolvedAgent = resolveAgentForSession(sessionID, undefined);
      helpers.scheduleSessionFallbackTimeout(sessionID, resolvedAgent);
      logInfo("Resetting fallback timeout due to activity", { sessionID, activityModel });
      return;
    }
    if (sessionAwaitingFallbackResult.size === 0) {
      return;
    }
    const cachedParentID = deps.sessionParentID.get(sessionID);
    const parentID = cachedParentID !== undefined ? cachedParentID : await helpers.getParentSessionID(sessionID);
    if (parentID && sessionAwaitingFallbackResult.has(parentID)) {
      const resolvedAgent = resolveAgentForSession(parentID, undefined);
      helpers.scheduleSessionFallbackTimeout(parentID, resolvedAgent);
      logInfo("Resetting parent fallback timeout due to child activity", {
        sessionID,
        parentID
      });
    }
  };
  const handleSessionCreated = (props: any): void => {
    const sessionInfo = props?.info;
    const sessionID = sessionInfo?.id;
    if (!sessionID)
      return;
    const parentID = sessionInfo?.parentID;
    if (typeof parentID === "string" && parentID.length > 0) {
      deps.sessionParentID.set(sessionID, parentID);
    }
    logInfo("Session created, state will be created on-demand", { sessionID });
  };
  const handleSessionDeleted = (props: any): void => {
    const sessionInfo = props?.info;
    const sessionID = sessionInfo?.id;
    if (sessionID) {
      logInfo("Cleaning up session state", { sessionID });
      sessionStates.delete(sessionID);
      sessionLastAccess.delete(sessionID);
      sessionRetryInFlight.delete(sessionID);
      sessionAwaitingFallbackResult.delete(sessionID);
      deps.sessionFirstTokenReceived.delete(sessionID);
      deps.sessionSelfAbortTimestamp.delete(sessionID);
      deps.sessionParentID.delete(sessionID);
      deps.sessionCompactionInFlight.delete(sessionID);
      deps.sessionIdleResolvers.delete(sessionID);
      deps.sessionLastMessageTime.delete(sessionID);
      deps.sessionLastMessageModel?.delete(sessionID);
      helpers.clearSessionFallbackTimeout(sessionID);
    }
  };
  const handleSessionStop = async (props: any): Promise<void> => {
    const sessionID = props?.sessionID;
    if (!sessionID)
      return;
    helpers.clearSessionFallbackTimeout(sessionID);
    if (sessionRetryInFlight.has(sessionID) || sessionAwaitingFallbackResult.has(sessionID)) {
      await helpers.abortSessionRequest(sessionID, "session.stop");
    }
    sessionRetryInFlight.delete(sessionID);
    sessionAwaitingFallbackResult.delete(sessionID);
    deps.sessionCompactionInFlight.delete(sessionID);
    deps.sessionSelfAbortTimestamp.delete(sessionID);
    const state = sessionStates.get(sessionID);
    if (state?.pendingFallbackModel) {
      state.pendingFallbackModel = undefined;
    }
    logInfo("Cleared fallback retry state on session.stop", { sessionID });
  };
  const handleSessionIdle = async (props: any): Promise<void> => {
    const sessionID = props?.sessionID;
    if (!sessionID)
      return;
    const idleResolvers = deps.sessionIdleResolvers.get(sessionID);
    if (idleResolvers && idleResolvers.length > 0) {
      logInfo("session.idle resolving waiters", {
        sessionID,
        waiterCount: idleResolvers.length
      });
      for (const resolve of idleResolvers)
        resolve();
      deps.sessionIdleResolvers.delete(sessionID);
    }
    if (sessionAwaitingFallbackResult.has(sessionID)) {
      if (deps.sessionCompactionInFlight.has(sessionID)) {
        logInfo("session.idle during compaction in-flight \u2014 not a silent failure, waiting for session.compacted", {
          sessionID
        });
        return;
      }
      const firstTokenReceived = deps.sessionFirstTokenReceived.get(sessionID);
      if (!firstTokenReceived) {
        const state = sessionStates.get(sessionID);
        if (state) {
          logInfo("session.idle detected silent model failure (no first token received)", {
            sessionID,
            currentModel: state.currentModel,
            attemptCount: state.attemptCount
          });
          if (sessionRetryInFlight.has(sessionID)) {
            logInfo("session.idle silent failure \u2014 retry already in flight, skipping", {
              sessionID
            });
            return;
          }
          sessionRetryInFlight.add(sessionID);
          sessionAwaitingFallbackResult.delete(sessionID);
          helpers.clearSessionFallbackTimeout(sessionID);
          try {
            const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, undefined);
            const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, deps.agentConfigs, deps.globalFallbackModels);
            if (fallbackModels.length === 0) {
              logInfo("session.idle silent failure \u2014 no fallback models configured", {
                sessionID
              });
              return;
            }
            const plan = planFallback(sessionID, state, fallbackModels, config);
            if (plan.success) {
              await helpers.autoRetryWithFallback(sessionID, plan.newModel, resolvedAgent, "session.idle.silent-failure", plan);
            } else {
              logInfo("session.idle silent failure \u2014 no more fallback models available", {
                sessionID,
                error: plan.error
              });
            }
          } finally {
            sessionRetryInFlight.delete(sessionID);
          }
          return;
        }
      }
      logInfo("session.idle with first token received \u2014 fallback model completed", {
        sessionID
      });
      sessionAwaitingFallbackResult.delete(sessionID);
      helpers.clearSessionFallbackTimeout(sessionID);
      sessionRetryInFlight.delete(sessionID);
      const completedState = sessionStates.get(sessionID);
      if (completedState) {
        completedState.modelRetryCount = 0;
      }
      return;
    }
    const hadTimeout = sessionFallbackTimeouts.has(sessionID);
    helpers.clearSessionFallbackTimeout(sessionID);
    sessionRetryInFlight.delete(sessionID);
    const state = sessionStates.get(sessionID);
    if (state?.pendingFallbackModel) {
      state.pendingFallbackModel = undefined;
    }
    if (hadTimeout) {
      logInfo("Cleared fallback timeout after session completion", { sessionID });
    }
  };
  const handleStayOnFallback = async (
    sessionID: string,
    state: FallbackState,
    fallbackModels: string[],
    resolvedAgent: string | undefined,
    status: any,
    source: string
  ): Promise<void> => {
    state.modelRetryCount = (state.modelRetryCount || 0) + 1;
    if (state.modelRetryCount < MAX_MODEL_RETRIES) {
      logInfo(`${source} \u2014 current fallback model is healthy, staying on it (retry ${state.modelRetryCount}/${MAX_MODEL_RETRIES})`, {
        sessionID,
        originalModel: state.originalModel,
        currentModel: state.currentModel,
        modelRetryCount: state.modelRetryCount
      });
      await helpers.autoRetryWithFallback(sessionID, state.currentModel, resolvedAgent, source, undefined);
      return;
    }
    logInfo(`${source} \u2014 current fallback model failed ${state.modelRetryCount} consecutive retries, advancing to next fallback`, {
      sessionID,
      originalModel: state.originalModel,
      currentModel: state.currentModel,
      modelRetryCount: state.modelRetryCount
    });
    state.failedModels.set(state.currentModel, Date.now());
    state.modelRetryCount = 0;
    const plan = planFallback(sessionID, state, fallbackModels, config);
    if (plan.success) {
      helpers.notifyFallback({
        title: "Retry Detected -- Switching Model",
        newModel: plan.newModel,
        prefixMessage: status.message || "Provider retrying",
        attemptCount: state.attemptCount + 1,
        totalFallbackModels: fallbackModels.length
      });
      await helpers.autoRetryWithFallback(sessionID, plan.newModel, resolvedAgent, source, plan);
    } else if (!plan.success) {
      logError(`${source} fallback failed`, {
        sessionID,
        error: plan.error
      });
      if (plan.maxAttemptsReached) {
        await helpers.notifyExhausted({
          totalFallbackModels: fallbackModels.length,
          attemptCount: state.attemptCount
        });
      }
    }
  };
  const handleSessionStatus = async (props: any): Promise<void> => {
    const sessionID = props?.sessionID;
    const status = props?.status;
    const agent = props?.agent;
    if (!sessionID || !status || status.type !== "retry")
      return;
    if (sessionRetryInFlight.has(sessionID)) {
      logInfo("session.status skipped -- retry lock already held", { sessionID });
      return;
    }
    sessionRetryInFlight.add(sessionID);
    try {
      const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent);
      const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, deps.agentConfigs, deps.globalFallbackModels);
      logInfo("Provider retry detected", {
        sessionID,
        attempt: status.attempt,
        message: status.message,
        nextRetryMs: status.next,
        resolvedAgent,
        totalFallbackModels: fallbackModels.length
      });
      if (fallbackModels.length === 0) {
        if (config.notify_on_fallback) {
          await deps.ctx.client.tui.showToast({
            body: {
              title: "Provider Retrying",
              variant: "info",
              duration: 3000,
              message: `${status.message || "retrying..."} (no fallback models configured)`
            }
          }).catch(() => {});
        }
        return;
      }
      const nextRetryMs = status.next;
      if (typeof nextRetryMs === "number" && nextRetryMs > 0) {
        const now = Date.now();
        const timeoutMs = config.timeout_seconds * 1000;
        if (nextRetryMs > now + timeoutMs) {
          logInfo("Provider retry is beyond timeout, triggering immediate fallback", {
            sessionID,
            nextRetryMs,
            now,
            timeoutMs,
            diffSeconds: Math.round((nextRetryMs - now) / 1000)
          });
          await triggerImmediateFallback(sessionID, resolvedAgent, fallbackModels, status);
          return;
        }
      }
      const isNewState = !sessionStates.has(sessionID);
      const state = helpers.getOrCreateFallbackState(sessionID, {
        resolvedAgent,
        allowFirstAgentFallback: true
      });
      if (!state) {
        logInfo("No model info for session.status fallback", { sessionID });
        return;
      }
      if (isNewState) {
        logInfo("Creating on-demand state for session.status", {
          sessionID,
          model: state.originalModel,
          agent: resolvedAgent
        });
      }
      sessionAwaitingFallbackResult.delete(sessionID);
      helpers.clearSessionFallbackTimeout(sessionID);
      if (state.currentModel !== state.originalModel && !isModelInCooldown(state.currentModel, state, config.cooldown_seconds)) {
        await handleStayOnFallback(sessionID, state, fallbackModels, resolvedAgent, status, "session.status.stay-on-fallback");
        return;
      }
      const plan = planFallback(sessionID, state, fallbackModels, config);
      if (plan.success) {
        helpers.notifyFallback({
          title: "Retry Detected -- Switching Model",
          newModel: plan.newModel,
          prefixMessage: status.message || "Provider retrying",
          attemptCount: state.attemptCount + 1,
          totalFallbackModels: fallbackModels.length
        });
        await helpers.autoRetryWithFallback(sessionID, plan.newModel, resolvedAgent, "session.status", plan);
      } else if (!plan.success) {
        logError("session.status fallback failed", {
          sessionID,
          error: plan.error
        });
        if (plan.maxAttemptsReached) {
          await helpers.notifyExhausted({
            totalFallbackModels: fallbackModels.length,
            attemptCount: state.attemptCount
          });
        }
      }
    } finally {
      sessionRetryInFlight.delete(sessionID);
    }
  };
  const handleSessionError = async (props: any): Promise<void> => {
    const sessionID = props?.sessionID;
    const error = props?.error;
    const agent = props?.agent;
    const errorModel = props?.model;
    if (!sessionID) {
      logInfo("session.error without sessionID, skipping");
      return;
    }
    if (deps.sessionCompactionInFlight.has(sessionID)) {
      logInfo("Ignoring session.error during compaction in-flight", {
        sessionID,
        errorName: extractErrorName(error)
      });
      return;
    }
    const SELF_ABORT_WINDOW_MS = 2000;
    const selfAbortTs = deps.sessionSelfAbortTimestamp.get(sessionID);
    const errorName = extractErrorName(error);
    if (errorName === "MessageAbortedError" && selfAbortTs && Date.now() - selfAbortTs < SELF_ABORT_WINDOW_MS) {
      logInfo("Ignoring self-inflicted MessageAbortedError in session.error", {
        sessionID,
        msSinceAbort: Date.now() - selfAbortTs,
        awaitingFallback: sessionAwaitingFallbackResult.has(sessionID),
        retryInFlight: sessionRetryInFlight.has(sessionID)
      });
      return;
    }
    const currentState = sessionStates.get(sessionID);
    if (currentState?.pendingFallbackModel) {
      logInfo("Ignoring session.error while fallback replay is pending", {
        sessionID,
        pendingFallbackModel: currentState.pendingFallbackModel,
        currentModel: currentState.currentModel,
        errorName: extractErrorName(error)
      });
      return;
    }
    if (currentState && errorModel && errorModel !== currentState.currentModel) {
      logInfo("Ignoring stale session.error from previous model", {
        sessionID,
        staleModel: errorModel,
        currentModel: currentState.currentModel,
        errorName: extractErrorName(error)
      });
      return;
    }
    if (currentState && errorModel && currentState.failedModels.has(errorModel)) {
      logInfo("Ignoring session.error from already-failed model", {
        sessionID,
        errorModel,
        currentModel: currentState.currentModel,
        errorName: extractErrorName(error)
      });
      return;
    }
    if (sessionAwaitingFallbackResult.has(sessionID)) {
      logInfo("Ignoring session.error while awaiting fallback result (likely stale abort)", {
        sessionID,
        currentModel: currentState?.currentModel,
        errorName: extractErrorName(error)
      });
      return;
    }
    if (sessionRetryInFlight.has(sessionID)) {
      logInfo("session.error skipped -- retry in flight (early lock)", {
        sessionID,
        retryInFlight: true
      });
      return;
    }
    sessionRetryInFlight.add(sessionID);
    try {
      const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent);
      if (deps.sessionCompactionInFlight.has(sessionID)) {
        logInfo("session.error skipping \u2014 compaction already being handled by message.updated", {
          sessionID,
          resolvedAgent,
          errorName: extractErrorName(error)
        });
        return;
      }
      helpers.clearSessionFallbackTimeout(sessionID);
      const stateAfterAwait = sessionStates.get(sessionID);
      if (stateAfterAwait?.pendingFallbackModel) {
        logInfo("Ignoring session.error \u2014 fallback replay became pending during agent resolution", {
          sessionID,
          pendingFallbackModel: stateAfterAwait.pendingFallbackModel,
          currentModel: stateAfterAwait.currentModel,
          errorName: extractErrorName(error)
        });
        return;
      }
      logInfo("session.error received", {
        sessionID,
        agent,
        resolvedAgent,
        statusCode: extractStatusCode(error, config.retry_on_errors),
        errorName: extractErrorName(error),
        errorType: classifyErrorType(error)
      });
      const isRetryable = isRetryableError(error, config.retry_on_errors, config.retryable_error_patterns);
      let state = sessionStates.get(sessionID);
      const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, deps.agentConfigs, deps.globalFallbackModels);
      if (fallbackModels.length === 0) {
        logInfo("No fallback models configured", { sessionID, agent });
        return;
      }
      const inFallbackChain = state && state.currentModel !== state.originalModel;
      if (!isRetryable && !inFallbackChain) {
        logInfo("Error not retryable and not in fallback chain, skipping", {
          sessionID,
          retryable: false,
          inFallbackChain: false,
          statusCode: extractStatusCode(error, config.retry_on_errors),
          errorName: extractErrorName(error),
          errorType: classifyErrorType(error)
        });
        return;
      }
      if (!isRetryable && inFallbackChain) {
        logInfo("Non-retryable error but in fallback chain, continuing to next fallback", {
          sessionID,
          retryable: false,
          inFallbackChain: true,
          currentModel: state?.currentModel,
          originalModel: state?.originalModel,
          errorName: extractErrorName(error)
        });
      }
      if (!state) {
        const currentModel = props?.model;
        if (currentModel) {
          state = helpers.getOrCreateFallbackState(sessionID, { preferredModel: currentModel });
        } else if (!errorModel && sessionRetryInFlight.has(sessionID)) {
          logInfo("Deferring to message.updated handler (no state, no errorModel, retry in flight)", {
            sessionID,
            errorName: extractErrorName(error)
          });
          return;
        } else {
          const agentConfig = resolvedAgent && deps.agentConfigs ? deps.agentConfigs[resolvedAgent] : undefined;
          const agentModel = agentConfig?.model;
          if (agentModel) {
            logInfo("Derived model from agent config", {
              sessionID,
              agent: resolvedAgent,
              model: agentModel
            });
            state = helpers.getOrCreateFallbackState(sessionID, { preferredModel: agentModel });
          } else {
            const firstModel = helpers.findFirstAgentModel();
            if (firstModel) {
              logInfo("Using first available agent model for state creation", {
                sessionID,
                model: firstModel
              });
              state = helpers.getOrCreateFallbackState(sessionID, { preferredModel: firstModel });
            } else {
              logInfo("No model info available, cannot fallback", { sessionID });
              return;
            }
          }
        }
      } else {
        sessionLastAccess.set(sessionID, Date.now());
      }
      if (!state) return;
      const plan = planFallback(sessionID, state, fallbackModels, config);
      if (plan.success) {
        helpers.notifyFallback({
          title: "Model Fallback",
          newModel: plan.newModel,
          attemptCount: state.attemptCount + 1,
          totalFallbackModels: fallbackModels.length
        });
        await helpers.autoRetryWithFallback(sessionID, plan.newModel, resolvedAgent, "session.error", plan);
      } else {
        logError("Fallback preparation failed", {
          sessionID,
          error: plan.error
        });
      }
    } finally {
      sessionRetryInFlight.delete(sessionID);
    }
  };
  const handleSessionCompacted = (props: any): void => {
    const sessionID = props?.sessionID;
    if (!sessionID)
      return;
    const hadAwaiting = sessionAwaitingFallbackResult.has(sessionID);
    const hadCompaction = deps.sessionCompactionInFlight.has(sessionID);
    sessionAwaitingFallbackResult.delete(sessionID);
    sessionRetryInFlight.delete(sessionID);
    deps.sessionFirstTokenReceived.delete(sessionID);
    deps.sessionCompactionInFlight.delete(sessionID);
    helpers.clearSessionFallbackTimeout(sessionID);
    if (hadAwaiting || hadCompaction) {
      logInfo("Compaction completed, clearing fallback state", { sessionID });
    }
  };
  async function triggerImmediateFallback(
    sessionID: string,
    resolvedAgent: string | undefined,
    fallbackModels: string[],
    status: any
  ): Promise<void> {
    const state = helpers.getOrCreateFallbackState(sessionID, {
      resolvedAgent,
      allowFirstAgentFallback: true
    });
    if (!state) {
      logError("Cannot trigger immediate fallback - no model info", { sessionID });
      return;
    }
    sessionAwaitingFallbackResult.delete(sessionID);
    helpers.clearSessionFallbackTimeout(sessionID);
    if (state.currentModel !== state.originalModel && !isModelInCooldown(state.currentModel, state, config.cooldown_seconds)) {
      await handleStayOnFallback(sessionID, state, fallbackModels, resolvedAgent, status, "session.status.immediate-stay-on-fallback");
      return;
    }
    const plan = planFallback(sessionID, state, fallbackModels, config);
    if (plan.success) {
      helpers.notifyFallback({
        title: "Provider Retry Too Slow - Switching Model",
        newModel: plan.newModel,
        prefixMessage: status.message || "Provider retrying",
        immediate: true
      });
      await helpers.autoRetryWithFallback(sessionID, plan.newModel, resolvedAgent, "session.status.immediate", plan);
    } else if (!plan.success) {
      logError("Immediate fallback preparation failed", {
        sessionID,
        error: plan.error
      });
      if (plan.maxAttemptsReached) {
        await helpers.notifyExhausted({
          totalFallbackModels: fallbackModels.length
        });
      }
    }
  }
  return {
    handleEvent: async ({ event }: { event: any }): Promise<void> => {
      if (!config.enabled)
        return;
      const props = event.properties;
      if (event.type === "session.created") {
        handleSessionCreated(props);
        return;
      }
      if (event.type === "session.deleted") {
        handleSessionDeleted(props);
        return;
      }
      if (event.type === "session.stop") {
        await handleSessionStop(props);
        return;
      }
      if (event.type === "session.idle") {
        await handleSessionIdle(props);
        return;
      }
      if (event.type === "session.error") {
        await handleSessionError(props);
        return;
      }
      if (event.type === "session.status") {
        await handleSessionStatus(props);
        return;
      }
      if (event.type === "session.compacted") {
        handleSessionCompacted(props);
        return;
      }
    },
    handleActivity
  };
}

// message-update-handler.ts
function hasVisibleAssistantResponse(extractAutoRetrySignalFn: (info: any) => { signal: string } | undefined) {
  return async (ctx: PluginInput, sessionID: string, _info: any): Promise<boolean> => {
    try {
      const messagesResp: any = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory }
      });
      const msgs: any[] = messagesResp.data;
      if (!msgs || msgs.length === 0)
        return false;
      const lastAssistant = [...msgs].reverse().find((m) => m.info?.role === "assistant");
      if (!lastAssistant)
        return false;
      if (lastAssistant.info?.error)
        return false;
      const parts = lastAssistant.parts ?? lastAssistant.info?.parts;
      const hasToolCall = (parts ?? []).some((p: any) => p.type === "tool_call");
      const textFromParts = (parts ?? []).filter((p: any) => p.type === "text" && typeof p.text === "string").map((p: any) => p.text.trim()).filter((text: string) => text.length > 0).join("\n");
      if (hasToolCall)
        return true;
      if (!textFromParts)
        return false;
      if (extractAutoRetrySignalFn({ message: textFromParts }))
        return false;
      return true;
    } catch {
      return false;
    }
  };
}
async function checkLastAssistantForErrorContent(ctx: PluginInput, sessionID: string): Promise<string | undefined> {
  try {
    const messagesResp: any = await ctx.client.session.messages({
      path: { id: sessionID },
      query: { directory: ctx.directory }
    });
    const msgs: any[] = messagesResp.data;
    if (!msgs || msgs.length === 0)
      return undefined;
    const lastAssistant = [...msgs].reverse().find((m) => m.info?.role === "assistant");
    if (!lastAssistant)
      return undefined;
    const parts = lastAssistant.parts ?? lastAssistant.info?.parts;
    const result = extractErrorContentFromParts(parts);
    if (result.hasError)
      return result.errorMessage;
    const textResult = detectErrorInTextParts(parts);
    if (textResult.hasError)
      return textResult.errorMessage;
    return undefined;
  } catch {
    return undefined;
  }
}
function createMessageUpdateHandler(deps: EngineDeps, helpers: AutoRetryHelpers): (props: any) => Promise<void> {
  const {
    ctx,
    config,
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult
  } = deps;
  const checkVisibleResponse = hasVisibleAssistantResponse(extractAutoRetrySignal);
  return async (props: any): Promise<void> => {
    const info = props?.info;
    const sessionID = info?.sessionID;
    const retrySignalResult = extractAutoRetrySignal(info);
    const retrySignal = retrySignalResult?.signal;
    const timeoutEnabled = config.timeout_seconds > 0;
    const parts = props?.parts;
    const errorContentResult = containsErrorContent(parts);
    let error = info?.error ?? (retrySignal && timeoutEnabled ? { name: "ProviderRateLimitError", message: retrySignal } : undefined) ?? (errorContentResult.hasError ? {
      name: "MessageContentError",
      message: errorContentResult.errorMessage || "Message contains error content"
    } : undefined);
    const role = info?.role;
    const model = info?.model ?? (typeof info?.providerID === "string" && typeof info?.modelID === "string" ? `${info.providerID}/${info.modelID}` : undefined);
    if (sessionID && role === "assistant") {
      deps.sessionLastMessageTime.set(sessionID, Date.now());
      if (model && deps.sessionLastMessageModel) {
        deps.sessionLastMessageModel.set(sessionID, model);
      }
      logInfo("message.updated received", {
        sessionID,
        model,
        hasInfoError: !!info?.error,
        errorType: info?.error ? classifyErrorType(info.error) : undefined
      });
    }
    if (sessionID && role === "assistant" && !error) {
      const errorContent = await checkLastAssistantForErrorContent(ctx, sessionID);
      if (errorContent) {
        logInfo("Detected error content in message parts", {
          sessionID,
          errorContent: errorContent.slice(0, 200)
        });
        error = { name: "ContentError", message: errorContent };
      }
    }
    if (sessionID && role === "assistant" && !error) {
      if (!sessionAwaitingFallbackResult.has(sessionID)) {
        const needsTimeout = model && config.timeout_seconds > 0 && !deps.sessionFirstTokenReceived.get(sessionID) && !deps.sessionFallbackTimeouts.has(sessionID);
        if (needsTimeout) {
          helpers.getOrCreateFallbackState(sessionID, { preferredModel: model });
          const agent = info?.agent;
          helpers.resolveAgentForSessionFromContext(sessionID, agent).then((resolvedAgent) => {
            const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, deps.agentConfigs, deps.globalFallbackModels);
            if (fallbackModels.length > 0) {
              helpers.scheduleSessionFallbackTimeout(sessionID, resolvedAgent);
              logInfo("Scheduled primary model TTFT timeout", {
                sessionID,
                model,
                timeoutSeconds: config.timeout_seconds
              });
            }
          }).catch(() => {});
        } else if (sessionStates.has(sessionID)) {
          const eventHasContent = parts?.some((p: any) => p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0 || p.type === "tool_call" || p.type === "tool");
          if (eventHasContent) {
            deps.sessionFirstTokenReceived.set(sessionID, true);
          }
          if (deps.sessionFallbackTimeouts.has(sessionID)) {
            const agent = info?.agent;
            helpers.resolveAgentForSessionFromContext(sessionID, agent).then((resolvedAgent) => {
              helpers.scheduleSessionFallbackTimeout(sessionID, resolvedAgent);
            }).catch(() => {});
          }
        }
        return;
      }
      const hasVisible = await checkVisibleResponse(ctx, sessionID, info);
      if (!hasVisible) {
        const eventHasActivity = parts?.some((p: any) => p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0 || p.type === "tool_call");
        if (eventHasActivity) {
          deps.sessionFirstTokenReceived.set(sessionID, true);
        }
        logError("Assistant update observed without visible final response; keeping fallback timeout", { sessionID, model, firstTokenReceived: deps.sessionFirstTokenReceived.get(sessionID) ?? false });
        return;
      }
      deps.sessionFirstTokenReceived.set(sessionID, true);
      sessionAwaitingFallbackResult.delete(sessionID);
      helpers.clearSessionFallbackTimeout(sessionID);
      const state = sessionStates.get(sessionID);
      if (state?.pendingFallbackModel) {
        state.pendingFallbackModel = undefined;
      }
      logInfo("Assistant response observed; cleared fallback timeout", {
        sessionID,
        model
      });
      return;
    }
    if (sessionID && role === "assistant" && error) {
      if (deps.sessionCompactionInFlight.has(sessionID)) {
        logInfo("Ignoring message.updated error during compaction in-flight", {
          sessionID,
          model,
          errorName: extractErrorName(error)
        });
        return;
      }
      const currentState = sessionStates.get(sessionID);
      const eventAgent = info?.agent?.trim().toLowerCase();
      const isCompactionError = eventAgent === "compaction";
      if (currentState && model && model !== currentState.currentModel) {
        if (isCompactionError) {
          logInfo("Compaction error on failed model \u2014 will retry on current fallback", {
            sessionID,
            failedModel: model,
            currentModel: currentState.currentModel,
            errorName: extractErrorName(error)
          });
        } else {
          const isAlreadyFailed = currentState.failedModels.has(model);
          const retryableStaleError = isRetryableError(error, config.retry_on_errors, config.retryable_error_patterns);
          const canResyncToErrorModel = retryableStaleError && !isAlreadyFailed && !currentState.pendingFallbackModel && !sessionAwaitingFallbackResult.has(sessionID);
          if (canResyncToErrorModel) {
            logInfo("Resyncing state to error model before fallback planning", {
              sessionID,
              previousModel: currentState.currentModel,
              errorModel: model,
              errorName: extractErrorName(error)
            });
            currentState.currentModel = model;
            sessionLastAccess.set(sessionID, Date.now());
          } else {
            logInfo("Ignoring stale error from previous model", {
              sessionID,
              staleModel: model,
              currentModel: currentState.currentModel,
              errorName: extractErrorName(error),
              isAlreadyFailed
            });
            return;
          }
        }
      }
      const SELF_ABORT_WINDOW_MS = 2000;
      const errorName = extractErrorName(error);
      const selfAbortTs = deps.sessionSelfAbortTimestamp.get(sessionID);
      if (errorName === "MessageAbortedError" && selfAbortTs && Date.now() - selfAbortTs < SELF_ABORT_WINDOW_MS) {
        logInfo("Ignoring self-inflicted MessageAbortedError (abort initiated by plugin)", {
          sessionID,
          model,
          msSinceAbort: Date.now() - selfAbortTs,
          awaitingFallback: sessionAwaitingFallbackResult.has(sessionID),
          retryInFlight: sessionRetryInFlight.has(sessionID)
        });
        return;
      }
      sessionAwaitingFallbackResult.delete(sessionID);
      if (sessionRetryInFlight.has(sessionID) && !retrySignal) {
        logInfo("message.updated fallback skipped (retry in flight)", {
          sessionID
        });
        return;
      }
      if (retrySignal && sessionRetryInFlight.has(sessionID) && timeoutEnabled) {
        logError("Overriding in-flight retry due to provider auto-retry signal", { sessionID, model });
        await helpers.abortSessionRequest(sessionID, "message.updated.retry-signal");
        sessionRetryInFlight.delete(sessionID);
      }
      deps.sessionRetryInFlight.add(sessionID);
      try {
        if (retrySignal && timeoutEnabled) {
          logInfo("Detected provider auto-retry signal", { sessionID, model });
        }
        if (!retrySignal) {
          helpers.clearSessionFallbackTimeout(sessionID);
        }
        logInfo("message.updated with assistant error", {
          sessionID,
          model,
          statusCode: extractStatusCode(error, config.retry_on_errors),
          errorName: extractErrorName(error),
          errorType: classifyErrorType(error)
        });
        let state = sessionStates.get(sessionID);
        const agent = info?.agent;
        const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent);
        if (resolvedAgent === "compaction") {
          deps.sessionCompactionInFlight.add(sessionID);
        }
        if (isCompactionError && state && state.currentModel !== model && state.currentModel !== state.originalModel) {
          logInfo("Compaction failed on stale model \u2014 re-dispatching on current fallback", {
            sessionID,
            failedModel: model,
            currentFallbackModel: state.currentModel
          });
          deps.sessionCompactionInFlight.add(sessionID);
          if (config.notify_on_fallback) {
            const fromName = (model || "primary").split("/").pop();
            const toName = state.currentModel.split("/").pop() || state.currentModel;
            deps.ctx.client.tui.showToast({
              body: {
                title: "Compaction Fallback",
                message: `${fromName} failed \u2014 retrying compaction on ${toName}`,
                variant: "warning",
                duration: 5000
              }
            }).catch(() => {});
          }
          await helpers.autoRetryWithFallback(sessionID, state.currentModel, "compaction", "message.updated.compaction-stale", undefined);
          return;
        }
        const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, deps.agentConfigs, deps.globalFallbackModels);
        if (fallbackModels.length === 0) {
          return;
        }
        if (state && state.pendingFallbackModel && model !== state.pendingFallbackModel) {
          logInfo("Skipping duplicate fallback trigger (already in progress for different model)", {
            sessionID,
            pendingFallbackModel: state.pendingFallbackModel,
            errorModel: model
          });
          return;
        }
        const isRetryable = isRetryableError(error, config.retry_on_errors, config.retryable_error_patterns);
        const inFallbackChain = state && state.currentModel !== state.originalModel;
        if (!isRetryable && !inFallbackChain) {
          logError("message.updated error not retryable and not in fallback chain, skipping", {
            sessionID,
            statusCode: extractStatusCode(error, config.retry_on_errors),
            errorName: extractErrorName(error),
            errorType: classifyErrorType(error)
          });
          return;
        }
        if (!isRetryable && inFallbackChain) {
          logInfo("message.updated non-retryable error but in fallback chain, continuing", {
            sessionID,
            currentModel: state?.currentModel,
            originalModel: state?.originalModel,
            errorName: extractErrorName(error)
          });
        }
        if (!state) {
          let initialModel = model;
          if (!initialModel) {
            const agentConfig = resolvedAgent && deps.agentConfigs ? deps.agentConfigs[resolvedAgent] : undefined;
            const agentModel = agentConfig?.model;
            if (agentModel) {
              logError("Derived model from agent config for message.updated", {
                sessionID,
                agent: resolvedAgent,
                model: agentModel
              });
              initialModel = agentModel;
            }
          }
          if (!initialModel) {
            logError("message.updated missing model info, cannot fallback", {
              sessionID,
              errorName: extractErrorName(error),
              errorType: classifyErrorType(error)
            });
            return;
          }
          state = helpers.getOrCreateFallbackState(sessionID, { preferredModel: initialModel });
        } else {
          sessionLastAccess.set(sessionID, Date.now());
          if (state.pendingFallbackModel && retrySignal && timeoutEnabled) {
            logError("Clearing pending fallback due to provider auto-retry signal", {
              sessionID,
              pendingFallbackModel: state.pendingFallbackModel
            });
            state.pendingFallbackModel = undefined;
          }
        }
        if (!state) return;
        const plan = planFallback(sessionID, state, fallbackModels, config);
        if (plan.success) {
          helpers.notifyFallback({
            newModel: plan.newModel
          });
          await helpers.autoRetryWithFallback(sessionID, plan.newModel, resolvedAgent, "message.updated", plan);
        }
      } finally {
        deps.sessionRetryInFlight.delete(sessionID);
      }
    }
  };
}

// chat-message-handler.ts
function createChatMessageHandler(deps: EngineDeps, helpers: AutoRetryHelpers): (input: any, output: any) => Promise<void> {
  const {
    config,
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult
  } = deps;
  return async (input: any, output: any): Promise<void> => {
    if (!config.enabled)
      return;
    const { sessionID } = input;
    let state = sessionStates.get(sessionID);
    if (!state) {
      return;
    }
    sessionLastAccess.set(sessionID, Date.now());
    const requestedModel = input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined;
    if (requestedModel && requestedModel === state.currentModel && state.currentModel !== state.originalModel && !deps.sessionCompactionInFlight.has(sessionID) && !sessionRetryInFlight.has(sessionID) && !sessionAwaitingFallbackResult.has(sessionID)) {
      logInfo("Adopting current model as new primary (user confirmed manual selection)", {
        sessionID,
        model: requestedModel,
        previousOriginal: state.originalModel
      });
      state.originalModel = requestedModel;
      state.failedModels.clear();
      state.fallbackIndex = -1;
      state.attemptCount = 0;
      return;
    }
    if (state.currentModel !== state.originalModel) {
      if (!sessionRetryInFlight.has(sessionID) && !sessionAwaitingFallbackResult.has(sessionID)) {
        const recovered = recoverToOriginal(state, config.cooldown_seconds);
        if (recovered) {
          logInfo("Recovered to primary model", {
            sessionID,
            model: state.originalModel
          });
          helpers.notifyRecovered(state.originalModel);
        }
      }
    }
    if (requestedModel && requestedModel !== state.currentModel) {
      if (state.pendingFallbackModel && state.pendingFallbackModel === requestedModel) {
        state.pendingFallbackModel = undefined;
        return;
      }
      if (sessionRetryInFlight.has(sessionID) || sessionAwaitingFallbackResult.has(sessionID)) {
        logInfo("Ignoring model mismatch during active fallback management", {
          sessionID,
          requestedModel,
          currentModel: state.currentModel,
          retryInFlight: sessionRetryInFlight.has(sessionID),
          awaitingResult: sessionAwaitingFallbackResult.has(sessionID)
        });
        return;
      }
      logError("Detected manual model change, resetting fallback state", {
        sessionID,
        from: state.currentModel,
        to: requestedModel
      });
      helpers.clearSessionFallbackTimeout(sessionID);
      sessionAwaitingFallbackResult.delete(sessionID);
      deps.sessionFirstTokenReceived.delete(sessionID);
      if (sessionRetryInFlight.has(sessionID)) {
        await helpers.abortSessionRequest(sessionID, "manual-model-change");
        sessionRetryInFlight.delete(sessionID);
      }
      state = createFallbackState(requestedModel);
      sessionStates.set(sessionID, state);
      return;
    }
    if (state.currentModel === state.originalModel)
      return;
    const activeModel = state.currentModel;
    logInfo("Applying fallback model override", {
      sessionID,
      from: input.model,
      to: activeModel
    });
    if (output.message && activeModel) {
      const parts = activeModel.split("/");
      if (parts.length >= 2) {
        output.message.model = {
          providerID: parts[0],
          modelID: parts.slice(1).join("/")
        };
      }
    }
    deps.sessionCompactionInFlight.delete(sessionID);
  };
}

// subagent-result-sync.ts
function isEmptyTaskResult(output?: string): boolean {
  if (!output) return false;
  return /<task_result>\s*<\/task_result>/.test(output);
}
const TASK_ID_REGEX = /task_id:\s*(ses_[a-zA-Z0-9]+)/;
function extractChildSessionID(output?: string): string | null {
  if (!output)
    return null;
  const match = output.match(TASK_ID_REGEX);
  return match ? match[1] : null;
}
function getSessionStatusType(sessionData: any): string | undefined {
  const status = sessionData?.status;
  if (!status)
    return undefined;
  if (typeof status === "string")
    return status;
  if (typeof status === "object" && status !== null && "type" in status) {
    return status.type;
  }
  return undefined;
}
function waitForSessionIdle(deps: EngineDeps, sessionID: string, inactivityMs: number, pollIntervalMs = 2000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSeenMessageTime = deps.sessionLastMessageTime.get(sessionID) ?? Date.now();
    const settle = (result: boolean): void => {
      if (settled)
        return;
      settled = true;
      if (pollTimer)
        clearInterval(pollTimer);
      if (timeoutTimer)
        clearTimeout(timeoutTimer);
      const resolvers = deps.sessionIdleResolvers.get(sessionID);
      if (resolvers) {
        const idx = resolvers.indexOf(onIdleRef);
        if (idx >= 0)
          resolvers.splice(idx, 1);
        if (resolvers.length === 0)
          deps.sessionIdleResolvers.delete(sessionID);
      }
      resolve(result);
    };
    const onIdleRef = (): void => settle(true);
    let resolvers = deps.sessionIdleResolvers.get(sessionID);
    if (!resolvers) {
      resolvers = [];
      deps.sessionIdleResolvers.set(sessionID, resolvers);
    }
    resolvers.push(onIdleRef);
    const resetTimeout = (): void => {
      if (timeoutTimer)
        clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => settle(false), inactivityMs);
    };
    resetTimeout();
    const pollStatus = (): void => {
      if (settled)
        return;
      const currentMessageTime = deps.sessionLastMessageTime.get(sessionID);
      if (currentMessageTime && currentMessageTime > lastSeenMessageTime) {
        lastSeenMessageTime = currentMessageTime;
        resetTimeout();
      }
      deps.ctx.client.session.get({ path: { id: sessionID } }).then((sessionInfo: any) => {
        if (settled)
          return;
        const statusType = getSessionStatusType(sessionInfo?.data ?? sessionInfo);
        if (statusType === "idle") {
          logInfo(`[subagent-sync] Polling detected child ${sessionID} idle`);
          settle(true);
        }
      }).catch(() => {});
    };
    pollStatus();
    pollTimer = setInterval(pollStatus, pollIntervalMs);
  });
}
async function waitForChildFallbackResult(
  deps: EngineDeps,
  childSessionID: string,
  options?: { maxWaitMs?: number; pollIntervalMs?: number }
): Promise<string | null> {
  const maxWaitMs = options?.maxWaitMs ?? Math.min((deps.config.timeout_seconds || 120) * 1000, 120000);
  const pollIntervalMs = options?.pollIntervalMs ?? 500;
  const startTime = Date.now();
  logInfo(`[subagent-sync] Waiting for child ${childSessionID} fallback result (max ${maxWaitMs}ms idle timeout)`);
  while (deps.sessionRetryInFlight.has(childSessionID)) {
    if (Date.now() - startTime >= maxWaitMs) {
      logInfo(`[subagent-sync] Timed out waiting for child ${childSessionID} dispatch after ${maxWaitMs}ms`);
      return null;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  const remainingMs = Math.max(1000, maxWaitMs - (Date.now() - startTime));
  const wentIdle = await waitForSessionIdle(deps, childSessionID, remainingMs, pollIntervalMs);
  if (!wentIdle) {
    logInfo(`[subagent-sync] Timed out waiting for child ${childSessionID} after ${Date.now() - startTime}ms`);
    return null;
  }
  const result = await extractAssistantResponse(deps, childSessionID);
  if (result) {
    logInfo(`[subagent-sync] Got fallback result for ${childSessionID} (${Date.now() - startTime}ms)`);
    return result;
  }
  logInfo(`[subagent-sync] Child ${childSessionID} idle but no assistant response found`);
  return null;
}
async function extractAssistantResponse(deps: EngineDeps, childSessionID: string): Promise<string | null> {
  try {
    const msgs: any = await deps.ctx.client.session.messages({
      path: { id: childSessionID },
      query: { directory: deps.ctx.directory }
    });
    if (!msgs.data || msgs.data.length === 0)
      return null;
    const lastAssistant = [...msgs.data].reverse().find((m: any) => m.info?.role === "assistant");
    if (!lastAssistant?.parts)
      return null;
    const textParts = lastAssistant.parts.filter((p: any) => p.type === "text" && p.text).map((p: any) => p.text);
    if (textParts.length === 0)
      return null;
    return textParts.join("");
  } catch (err) {
    logInfo(`[subagent-sync] Error reading child messages: ${err}`);
    return null;
  }
}

// index.ts
function loadPluginConfig(directory: string): FallbackConfigOverrides {
  const configPaths = [
    join(directory, ".opencode", "opencode-fallback.json"),
    join(directory, ".opencode", "opencode-fallback.jsonc"),
    join(process.env.HOME || "", ".config", "opencode", "opencode-fallback.json"),
    join(process.env.HOME || "", ".config", "opencode", "opencode-fallback.jsonc")
  ];
  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, "utf-8");
        return parseJsonc(content) ?? {};
      } catch (err) {
        logInfo(`[${PLUGIN_NAME}] Failed to parse config: ${configPath}`, err);
      }
    }
  }
  return {};
}
async function OpenCodeFallbackPlugin(ctx: PluginInput, configOverrides?: FallbackConfigOverrides): Promise<Hooks> {
  let agentConfigs: AgentConfigs | undefined;
  let fileConfig = loadPluginConfig(ctx.directory);
  let mergedConfig: FallbackConfig | undefined;
  const globalFallbackModels = normalizeFallbackModelsField(fileConfig.fallback_models);
  const getConfig = (): FallbackConfig => {
    mergedConfig ??= {
      enabled: configOverrides?.enabled ?? fileConfig?.enabled ?? DEFAULT_CONFIG.enabled,
      retry_on_errors: configOverrides?.retry_on_errors ?? fileConfig?.retry_on_errors ?? DEFAULT_CONFIG.retry_on_errors,
      retryable_error_patterns: configOverrides?.retryable_error_patterns ?? fileConfig?.retryable_error_patterns ?? DEFAULT_CONFIG.retryable_error_patterns,
      max_fallback_attempts: configOverrides?.max_fallback_attempts ?? fileConfig?.max_fallback_attempts ?? DEFAULT_CONFIG.max_fallback_attempts,
      cooldown_seconds: configOverrides?.cooldown_seconds ?? fileConfig?.cooldown_seconds ?? DEFAULT_CONFIG.cooldown_seconds,
      timeout_seconds: configOverrides?.timeout_seconds ?? fileConfig?.timeout_seconds ?? DEFAULT_CONFIG.timeout_seconds,
      notify_on_fallback: configOverrides?.notify_on_fallback ?? fileConfig?.notify_on_fallback ?? DEFAULT_CONFIG.notify_on_fallback,
      routing_mode: configOverrides?.routing_mode ?? fileConfig?.routing_mode ?? DEFAULT_CONFIG.routing_mode,
      fallback_models: configOverrides?.fallback_models ?? fileConfig?.fallback_models ?? DEFAULT_CONFIG.fallback_models
    };
    return mergedConfig;
  };
  const deps: EngineDeps = {
    ctx,
    get config() {
      return getConfig();
    },
    get agentConfigs() {
      return agentConfigs;
    },
    globalFallbackModels,
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionFirstTokenReceived: new Map(),
    sessionSelfAbortTimestamp: new Map(),
    sessionParentID: new Map(),
    sessionIdleResolvers: new Map(),
    sessionLastMessageTime: new Map(),
    sessionLastMessageModel: new Map(),
    sessionCompactionInFlight: new Set()
  };
  const helpers = createAutoRetryHelpers(deps);
  const { handleEvent: baseEventHandler, handleActivity } = createEventHandler(deps, helpers);
  const messageUpdateHandler = createMessageUpdateHandler(deps, helpers);
  const chatMessageHandler = createChatMessageHandler(deps, helpers);
  const cleanupInterval = setInterval(helpers.cleanupStaleSessions, 5 * 60 * 1000);
  cleanupInterval.unref();
  logInfo(`Plugin initialized (${globalFallbackModels.length} global fallback model(s) configured)`);
  return {
    config: async (opencodeConfig: any) => {
      const agentsValue = opencodeConfig.agents;
      const agentValue = opencodeConfig.agent;
      if (agentsValue && typeof agentsValue === "object" && !Array.isArray(agentsValue)) {
        agentConfigs = agentsValue;
      } else if (agentValue && typeof agentValue === "object" && !Array.isArray(agentValue)) {
        agentConfigs = agentValue;
      } else {
        agentConfigs = undefined;
      }
      logInfo(`Plugin initialized with ${agentConfigs ? Object.keys(agentConfigs).length : 0} agents`);
    },
    event: async ({
      event
    }: {
      event: any;
    }) => {
      if (event.type === "message.updated") {
        if (!deps.config.enabled)
          return;
        const props = event.properties;
        await messageUpdateHandler(props);
        return;
      }
      if (event.type === "message.part.delta" || event.type === "session.diff" || event.type === "message.part.updated") {
        const props = event.properties;
        const info = props?.info;
        const sessionID = props?.sessionID ?? info?.sessionID ?? info?.id;
        const activityModel = info?.model ?? (typeof info?.providerID === "string" && typeof info?.modelID === "string" ? `${info.providerID}/${info.modelID}` : undefined) ?? props?.model;
        if (sessionID) {
          await handleActivity(sessionID, activityModel);
        }
      }
      await baseEventHandler({ event });
    },
    "tool.execute.after": async (input: any, output: any) => {
      if (input.tool !== "task" || !isEmptyTaskResult(output.output)) {
        return;
      }
      const childSessionID = extractChildSessionID(output.output);
      if (!childSessionID) {
        logInfo("Empty task result but no child session ID found", {
          sessionID: input.sessionID,
          outputPreview: output.output?.substring(0, 200)
        });
        return;
      }
      logInfo("Detected empty task result, waiting for child fallback", {
        parentSession: input.sessionID,
        childSession: childSessionID
      });
      const maxWaitMs = Math.min((deps.config.timeout_seconds || 120) * 1000, 120000);
      const replacementText = await waitForChildFallbackResult(deps, childSessionID, {
        maxWaitMs,
        pollIntervalMs: 500
      });
      if (replacementText) {
        output.output = replacementText;
        logInfo("Replaced empty task result with fallback response", {
          parentSession: input.sessionID,
          childSession: childSessionID,
          responseLength: replacementText.length
        });
      } else {
        logInfo("No fallback response available, preserving original output", {
          parentSession: input.sessionID,
          childSession: childSessionID
        });
      }
    },
    "chat.message": async (input: any, output: any) => {
      await chatMessageHandler(input, output);
    }
  };
}
export {
  OpenCodeFallbackPlugin as default
};
