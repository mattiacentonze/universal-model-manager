import {
  WindowedRecord,
  WindowedAccountState,
  WindowedTrackerOptions,
  WindowedTracker,
} from "./windowed-tracker.js";

export interface LatencyRecord extends WindowedRecord {
  timestamp: number;
  durationMs: number;
}

export interface AccountLatencyState extends WindowedAccountState<LatencyRecord> {
  samples: LatencyRecord[];
  ema: number; // Exponential Moving Average
  lastUpdated: number;
}

export interface LatencyTrackerOptions extends WindowedTrackerOptions {
  windowMs?: number;
  alpha?: number; // Smoothing factor for EMA (0 < alpha <= 1)
  clock?: () => number;
}

export class LatencyTracker extends WindowedTracker<
  LatencyRecord,
  AccountLatencyState,
  LatencyTrackerOptions
> {
  private alpha: number;

  constructor(options: LatencyTrackerOptions = {}) {
    super(options, 60_000);
    this.alpha = options.alpha ?? 0.3;
  }

  protected createInitialState(_accountId: string, now: number): AccountLatencyState {
    const samples: LatencyRecord[] = [];
    return {
      records: samples,
      samples,
      ema: 0,
      lastUpdated: now,
    };
  }

  protected override onBeforeAddRecord(
    state: AccountLatencyState,
    record: LatencyRecord,
    isNew: boolean,
    now: number
  ): void {
    if (isNew) {
      state.ema = record.durationMs;
    } else {
      state.ema = this.alpha * record.durationMs + (1 - this.alpha) * state.ema;
    }
    state.lastUpdated = now;
  }

  public recordLatency(accountId: string | number, durationMs: number): void {
    const now = this.clock();
    this.addRecord(accountId, { timestamp: now, durationMs }, now);
  }

  public getAverageLatency(accountId: string | number): number {
    const state = this.getAccount(accountId);
    if (!state) return 0;
    this.prune(state, this.clock());
    return state.ema;
  }

  public getRankedAccounts(accountIds: Array<string | number>): string[] {
    return this.rankAccounts(accountIds, a => this.getAverageLatency(a) || Infinity);
  }
}
