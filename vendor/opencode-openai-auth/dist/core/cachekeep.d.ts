import type { AccountStorage } from './accounts.ts';
export type CacheKeepWindow = {
    startHour: number;
    endHour: number;
};
export interface Target {
    bodyText: string;
    accountId: string | undefined;
    chatgptAccountId?: string;
    route: 'main';
    cacheExpiresAt: number;
    ttlMs: number;
    warmCount: number;
    lastRealRequestAt: number;
    lastWarmedAt?: number;
    backoffUntil?: number;
    replayHeaders: Record<string, string>;
    isSubagent?: boolean;
    is56: boolean;
}
export interface CacheKeepManagerOptions {
    fetchImpl: typeof fetch;
    getMainToken: () => Promise<string>;
    refreshFallback: (accountId: string) => Promise<string>;
    codexResponsesUrl: string;
    logger: {
        info: (msg: string, data?: unknown) => void;
        warn: (msg: string, data?: unknown) => void;
        debug: (msg: string, data?: unknown) => void;
        error: (msg: string, data?: unknown) => void;
    };
    now: () => number;
    ttlMs?: number;
    leadMs?: number;
    maxDurationMs?: number;
    maxIdleWarmMs?: number;
    maxSubagentIdleMs?: number;
    tickIntervalMs?: number;
    maxTargets?: number;
    maxBytes?: number;
    /** Returns the configured clock-hour window; undefined means always warm. */
    getWindow?: () => CacheKeepWindow | undefined;
    /** Returns whether main-agent targets bypass only the idle warm cap. */
    getSustain?: () => boolean;
}
export interface CacheKeepStatus {
    running: boolean;
    tracked: number;
    generatedAt: number;
    startedAt: number | null;
    maxIdleWarmMs: number;
    maxSubagentIdleMs: number;
    ttlMs: number;
    leadMs: number;
    sustain: boolean;
    window?: CacheKeepWindow;
    targets: Array<{
        sessionKey: string;
        accountId: string | undefined;
        route: 'main';
        cacheExpiresAt: number;
        lastRealRequestAt: number;
        lastWarmedAt?: number;
        backoffUntil?: number;
        bodyBytes: number;
    }>;
}
export interface KeepwarmCapture {
    sessionKey: string;
    bodyText: string;
    replayHeaders: Record<string, string>;
    isSubagent: boolean;
}
export declare function buildKeepwarmCapture(input: {
    enabled: boolean;
    includeSubagents: boolean;
    headers: Headers;
    body: unknown;
}): KeepwarmCapture | undefined;
export declare function getCacheKeepWindow(storage: AccountStorage | null): CacheKeepWindow | undefined;
export declare function isWithinCacheKeepWindow(window: CacheKeepWindow | undefined, now?: Date): boolean;
export declare function buildKeepwarmBody(bodyText: string): string;
export declare function ttlForModel(bodyText: string, defaultTtlMs: number): number;
export declare class CacheKeepManager {
    private readonly targets;
    private readonly fetchImpl;
    private readonly getMainToken;
    private readonly refreshFallback;
    private readonly codexResponsesUrl;
    private readonly log;
    private readonly now;
    private readonly ttlMs;
    private readonly leadMs;
    private readonly maxIdleWarmMs;
    private readonly maxSubagentIdleMs;
    private readonly tickIntervalMs;
    private readonly maxTargets;
    private readonly maxBytes;
    private readonly getWindow?;
    private readonly getSustain?;
    private timer;
    private startedAt;
    private totalBytes;
    private tickInFlight;
    private disposed;
    private abortController;
    private logPayload;
    constructor(options: CacheKeepManagerOptions);
    track(sessionKey: string, bodyText: string, accountId: string | undefined, chatgptAccountId?: string, replayHeaders?: Record<string, string>, isSubagent?: boolean): void;
    private isGpt56Subagent;
    private pruneStale;
    start(): void;
    stop(): void;
    remove(sessionKey: string): void;
    status(): CacheKeepStatus;
    tick(): Promise<void>;
    private prewarm;
}
