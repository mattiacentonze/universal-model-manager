export declare function isLostMarkerRaceError(error: unknown): boolean;
export declare function acquireRefreshFileLock(options: {
    name: string;
    ttlMs: number;
    path?: string;
    now?: () => number;
    renew?: boolean;
    renewIntervalMs?: number;
    onStep?: (step: 'stale-marker-stat' | 'stale-marker-claimed' | 'stale-lock-confirmed' | 'eviction-marker-acquired' | 'renewal-owner-confirmed' | 'renewal-marker-unavailable' | 'renewal-write-fenced' | 'renewal-write-ready' | 'relinquish-read' | 'renewal-finished' | 'release-owner-confirmed') => void | Promise<void>;
}): Promise<{
    release: () => Promise<void>;
} | null>;
