import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getUniversalAuthDataDir } from "../shared/paths.js";

export interface ZenTokenBucket {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ZenUsageState {
  buckets: ZenTokenBucket[];
  rateLimitedUntil: number | null;
  lastError: string | null;
  estimatedDailyLimit: number;
}

export interface ZenPacingResult {
  pacePercent: number;
  deltaPercent: number;
  state: "on-pace" | "deficit" | "reserve";
  runsOutAt: string | null;
}

export interface ZenStatus {
  isConfigured: boolean;
  model: string;
  totalTokens24h: number;
  inputTokens24h: number;
  outputTokens24h: number;
  estimatedLimit: number;
  usedPct: number;
  pacing: ZenPacingResult | null;
  isRateLimited: boolean;
  rateLimitResetFormatted: string | null;
  resetsInFormatted: string;
}

export const DEFAULT_ESTIMATED_DAILY_LIMIT = 2_500_000;
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;

export class ZenUsageTracker {
  private readonly filePath: string;

  constructor(filePath = join(getUniversalAuthDataDir(), "opencode-zen-usage.json")) {
    this.filePath = filePath;
  }

  private readState(): ZenUsageState {
    if (!existsSync(this.filePath)) {
      return {
        buckets: [],
        rateLimitedUntil: null,
        lastError: null,
        estimatedDailyLimit: DEFAULT_ESTIMATED_DAILY_LIMIT,
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      return {
        buckets: Array.isArray(parsed?.buckets) ? parsed.buckets : [],
        rateLimitedUntil: typeof parsed?.rateLimitedUntil === "number" ? parsed.rateLimitedUntil : null,
        lastError: typeof parsed?.lastError === "string" ? parsed.lastError : null,
        estimatedDailyLimit: typeof parsed?.estimatedDailyLimit === "number" ? parsed.estimatedDailyLimit : DEFAULT_ESTIMATED_DAILY_LIMIT,
      };
    } catch {
      return {
        buckets: [],
        rateLimitedUntil: null,
        lastError: null,
        estimatedDailyLimit: DEFAULT_ESTIMATED_DAILY_LIMIT,
      };
    }
  }

  private writeState(state: ZenUsageState): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch {
      // Ignored
    }
  }

  recordUsage(inputTokens: number, outputTokens: number, timestamp = Date.now()): void {
    const state = this.readState();
    const cutoff = timestamp - WINDOW_24H_MS;
    const activeBuckets = state.buckets.filter(b => b.timestamp > cutoff);
    activeBuckets.push({ timestamp, inputTokens, outputTokens });
    state.buckets = activeBuckets;
    this.writeState(state);
  }

  recordRateLimit(untilMs: number, errorMsg?: string): void {
    const state = this.readState();
    state.rateLimitedUntil = untilMs;
    state.lastError = errorMsg ?? "Rate limit reached";
    this.writeState(state);
  }

  clearRateLimit(): void {
    const state = this.readState();
    state.rateLimitedUntil = null;
    state.lastError = null;
    this.writeState(state);
  }

  setEstimatedDailyLimit(limit: number): void {
    if (limit > 0) {
      const state = this.readState();
      state.estimatedDailyLimit = limit;
      this.writeState(state);
    }
  }

  getStatus(isConfigured = true, model = "big-pickle"): ZenStatus {
    const state = this.readState();
    const now = Date.now();
    const cutoff = now - WINDOW_24H_MS;
    const active = state.buckets.filter(b => b.timestamp > cutoff);

    let inputTokens24h = 0;
    let outputTokens24h = 0;
    for (const b of active) {
      inputTokens24h += b.inputTokens;
      outputTokens24h += b.outputTokens;
    }
    const totalTokens24h = inputTokens24h + outputTokens24h;
    const estimatedLimit = state.estimatedDailyLimit || DEFAULT_ESTIMATED_DAILY_LIMIT;
    const usedPct = Math.min(Math.max((totalTokens24h / estimatedLimit) * 100, 0), 100);

    // Midnight UTC calculation for reset time
    const today = new Date(now);
    const startOfUtcDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const endOfUtcDay = startOfUtcDay + WINDOW_24H_MS;
    const elapsedToday = Math.max(0, now - startOfUtcDay);

    // Pacing calculation
    let pacing: ZenPacingResult | null = null;
    if (elapsedToday >= 5 * 60 * 1000) {
      const pacePercent = Math.min(Math.max((elapsedToday / WINDOW_24H_MS) * 100, 0), 100);
      const deltaPercent = usedPct - pacePercent;
      const pacingState = Math.abs(deltaPercent) < 1 ? "on-pace" : deltaPercent > 0 ? "deficit" : "reserve";

      let runsOutAt: string | null = null;
      if (usedPct > 0) {
        const msToFull = (elapsedToday * 100) / usedPct;
        const projectedEnd = startOfUtcDay + msToFull;
        if (projectedEnd < endOfUtcDay) {
          runsOutAt = new Date(projectedEnd).toISOString();
        }
      }

      pacing = {
        pacePercent,
        deltaPercent,
        state: pacingState,
        runsOutAt,
      };
    }

    // Rate limit status
    let isRateLimited = false;
    let rateLimitResetFormatted: string | null = null;
    if (state.rateLimitedUntil && state.rateLimitedUntil > now) {
      isRateLimited = true;
      const d = new Date(state.rateLimitedUntil);
      rateLimitResetFormatted = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }

    // Reset formatted string for 24h cycle
    const msUntilReset = Math.max(0, endOfUtcDay - now);
    const mins = Math.floor(msUntilReset / 60_000);
    const hrs = Math.floor(mins / 60);
    const rm = mins % 60;
    const resetsInFormatted = hrs > 0 ? (rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`) : `${mins}m`;

    return {
      isConfigured,
      model,
      totalTokens24h,
      inputTokens24h,
      outputTokens24h,
      estimatedLimit,
      usedPct,
      pacing,
      isRateLimited,
      rateLimitResetFormatted,
      resetsInFormatted,
    };
  }
}

export const zenUsageTracker = new ZenUsageTracker();
