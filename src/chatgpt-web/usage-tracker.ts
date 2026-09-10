import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getUniversalAuthDataDir } from "../shared/paths.js";
import { SessionStore } from "./session-store.js";

export interface ChatGptUsageState {
  tier: "Plus" | "Pro" | "Free/Go" | "Unknown";
  recentTurns: number[]; // timestamps of turns in rolling 3h window
  rateLimitedUntil: number | null;
  lastError: string | null;
}

export class UsageTracker {
  private readonly filePath: string;
  private readonly sessionStore: SessionStore;

  constructor(
    filePath = join(getUniversalAuthDataDir(), "chatgpt-usage.json"),
    sessionStore = new SessionStore()
  ) {
    this.filePath = filePath;
    this.sessionStore = sessionStore;
  }

  private readState(): ChatGptUsageState {
    if (!existsSync(this.filePath)) {
      return { tier: "Unknown", recentTurns: [], rateLimitedUntil: null, lastError: null };
    }
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      return { tier: "Unknown", recentTurns: [], rateLimitedUntil: null, lastError: null };
    }
  }

  private writeState(state: ChatGptUsageState): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch {
      // Ignored
    }
  }

  recordTurn(): void {
    const state = this.readState();
    const now = Date.now();
    const windowStart = now - 3 * 60 * 60 * 1000; // 3 hours
    state.recentTurns = [...state.recentTurns.filter(t => t > windowStart), now];
    this.writeState(state);
  }

  recordRateLimit(untilMs: number, errorMsg: string): void {
    const state = this.readState();
    state.rateLimitedUntil = untilMs;
    state.lastError = errorMsg;
    this.writeState(state);
  }

  clearRateLimit(): void {
    const state = this.readState();
    state.rateLimitedUntil = null;
    state.lastError = null;
    this.writeState(state);
  }

  getStatus(): {
    isLoggedIn: boolean;
    tier: string;
    turnsInWindow: number;
    isRateLimited: boolean;
    rateLimitResetFormatted: string | null;
  } {
    const isLoggedIn = this.sessionStore.hasValidSession();
    const state = this.readState();
    const now = Date.now();
    const windowStart = now - 3 * 60 * 60 * 1000;
    const activeTurns = state.recentTurns.filter(t => t > windowStart);

    let isRateLimited = false;
    let rateLimitResetFormatted: string | null = null;

    if (state.rateLimitedUntil && state.rateLimitedUntil > now) {
      isRateLimited = true;
      const date = new Date(state.rateLimitedUntil);
      rateLimitResetFormatted = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }

    return {
      isLoggedIn,
      tier: state.tier,
      turnsInWindow: activeTurns.length,
      isRateLimited,
      rateLimitResetFormatted,
    };
  }
}

export const usageTracker = new UsageTracker();
