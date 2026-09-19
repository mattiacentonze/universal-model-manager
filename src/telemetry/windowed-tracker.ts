export interface WindowedRecord {
  timestamp: number;
}

export interface WindowedAccountState<TRecord extends WindowedRecord = WindowedRecord> {
  records: TRecord[];
}

export interface WindowedTrackerOptions {
  windowMs?: number;
  clock?: () => number;
}

export abstract class WindowedTracker<
  TRecord extends WindowedRecord,
  TState extends WindowedAccountState<TRecord>,
  TOptions extends WindowedTrackerOptions = WindowedTrackerOptions,
> {
  protected accounts = new Map<string, TState>();
  protected windowMs: number;
  protected clock: () => number;

  constructor(options: TOptions = {} as TOptions, defaultWindowMs = 60_000) {
    this.windowMs = options.windowMs ?? defaultWindowMs;
    this.clock = options.clock ?? (() => Date.now());
  }

  public getOrCreateAccount(accountId: string | number, now = this.clock()): { state: TState; isNew: boolean } {
    const key = String(accountId);
    let state = this.accounts.get(key);
    let isNew = false;
    if (!state) {
      state = this.createInitialState(key, now);
      this.accounts.set(key, state);
      isNew = true;
    }
    return { state, isNew };
  }

  public getAccount(accountId: string | number): TState | undefined {
    return this.accounts.get(String(accountId));
  }

  public addRecord(accountId: string | number, record: TRecord, now = this.clock()): TState {
    const { state, isNew } = this.getOrCreateAccount(accountId, now);
    this.onBeforeAddRecord(state, record, isNew, now);
    state.records.push(record);
    this.prune(state, now);
    return state;
  }

  public prune(state: TState, now = this.clock()): void {
    const cutoff = now - this.windowMs;
    while (state.records.length > 0 && state.records[0].timestamp < cutoff) {
      state.records.shift();
    }
    this.onAfterPrune(state, now);
  }

  public clear(): void {
    this.accounts.clear();
  }

  public rankAccounts(accountIds: Array<string | number>, scoreFn: (accountId: string) => number): string[] {
    const list = accountIds.map((id) => String(id));
    return [...list].sort((a, b) => scoreFn(a) - scoreFn(b));
  }

  protected abstract createInitialState(accountId: string, now: number): TState;

  // Lifecycle hooks for tracker-specific aggregation logic
  protected onBeforeAddRecord(_state: TState, _record: TRecord, _isNew: boolean, _now: number): void {}

  protected onAfterPrune(_state: TState, _now: number): void {}
}
