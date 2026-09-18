export interface LatencyRecord {
  timestamp: number;
  durationMs: number;
}

export interface AccountLatencyState {
  samples: LatencyRecord[];
  ema: number; // Exponential Moving Average
  lastUpdated: number;
}

export interface LatencyTrackerOptions {
  windowMs?: number;
  alpha?: number; // Smoothing factor for EMA (0 < alpha <= 1)
  clock?: () => number;
}

export class LatencyTracker {
  private accounts = new Map<string, AccountLatencyState>();
  private windowMs: number;
  private alpha: number;
  private clock: () => number;

  constructor(options: LatencyTrackerOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.alpha = options.alpha ?? 0.3;
    this.clock = options.clock ?? (() => Date.now());
  }

  public recordLatency(accountId: string | number, durationMs: number): void {
    const key = String(accountId);
    const now = this.clock();
    let state = this.accounts.get(key);
    if (!state) {
      state = {
        samples: [],
        ema: durationMs,
        lastUpdated: now,
      };
      this.accounts.set(key, state);
    } else {
      state.ema = this.alpha * durationMs + (1 - this.alpha) * state.ema;
      state.lastUpdated = now;
    }
    state.samples.push({ timestamp: now, durationMs });
    this.prune(state, now);
  }

  public getAverageLatency(accountId: string | number): number {
    const key = String(accountId);
    const state = this.accounts.get(key);
    if (!state) return 0;
    this.prune(state, this.clock());
    return state.ema;
  }

  public getRankedAccounts(accountIds: Array<string | number>): string[] {
    const list = accountIds.map(id => String(id));
    return [...list].sort((a, b) => {
      const latA = this.getAverageLatency(a) || Infinity;
      const latB = this.getAverageLatency(b) || Infinity;
      return latA - latB;
    });
  }

  public clear(): void {
    this.accounts.clear();
  }

  private prune(state: AccountLatencyState, now: number): void {
    const cutoff = now - this.windowMs;
    while (state.samples.length > 0 && state.samples[0].timestamp < cutoff) {
      state.samples.shift();
    }
  }
}
