import { type RefreshAllQuotaDeps, type RefreshAllQuotaResult } from './refresh-all-quota';
export declare const BACKGROUND_QUOTA_REFRESH_INTERVAL_MS: number;
export declare const BACKGROUND_QUOTA_REFRESH_JITTER_MS = 30000;
export declare const BACKGROUND_QUOTA_FRESHNESS_MS: number;
export declare const BACKGROUND_QUOTA_REFRESH_LOCK_NAME = "bg-quota-refresh";
export declare const BACKGROUND_QUOTA_REFRESH_LOCK_TTL_MS = 120000;
type TimerHandle = ReturnType<typeof setInterval>;
interface BackgroundQuotaRefreshOptions {
    setIntervalFn?: (callback: () => void, intervalMs: number) => TimerHandle;
    clearIntervalFn?: (timer: TimerHandle) => void;
    random?: () => number;
    onError?: (error: unknown) => void;
}
type RefreshAllQuotaFn = (deps: RefreshAllQuotaDeps) => Promise<RefreshAllQuotaResult[]>;
type BackgroundLockHandle = {
    release: () => Promise<void>;
};
export type BackgroundLockAcquirer = () => Promise<BackgroundLockHandle | null>;
/**
 * Acquire the cross-process lock that serializes the background refresh.
 * `renew` re-arms the TTL on an interval until release(), so a serial pass that
 * outlasts the TTL (a fleet of accounts each costing a token refresh plus a
 * wham fetch) never lets the lock expire mid-run — an expiry would let a second
 * process start a concurrent refresh. Overrides exist so tests can drive the
 * renewal with a mock clock and a fast interval.
 */
export declare function acquireBackgroundRefreshLock(configPath: string, overrides?: {
    now?: () => number;
    renewIntervalMs?: number;
}): Promise<BackgroundLockHandle | null>;
export declare function refreshQuotaInBackground(deps: RefreshAllQuotaDeps, refreshFn?: RefreshAllQuotaFn, acquireLock?: BackgroundLockAcquirer): Promise<RefreshAllQuotaResult[]>;
export declare class BackgroundQuotaRefresh {
    private readonly setIntervalFn;
    private readonly clearIntervalFn;
    private readonly random;
    private onError;
    private run;
    private timer;
    private tickPromise;
    private stopped;
    constructor(options?: BackgroundQuotaRefreshOptions);
    start(run: () => Promise<void>, onError?: ((error: unknown) => void) | undefined): void;
    stop(): void;
    isStopped(): boolean;
}
export {};
