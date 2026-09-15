/**
 * Renewable fenced file lock.
 *
 * The lock file at `${path}.${name}.lock` holds the JSON
 * `{ ownerId, expiresAt }`. Acquiring it uses an exclusive `wx` write so
 * concurrent processes race deterministically — only one wins.
 *
 * A contended, live lock (ownerId present, expiresAt > now) returns
 * `null` immediately; no eviction is attempted and no destructive op
 * touches the file. A contended, stale lock (no owner, expired, or
 * malformed-but-old) opens an eviction protocol that uses an exclusive
 * "evicting" marker directory at `${lockPath}.evicting/owner.json` as a
 * fence: the file holds the in-progress evicter's ownerId. The marker
 * is verified before every destructive seam (re-read, unlink,
 * re-acquire) so a contender whose marker has been hijacked will see
 * ownership has changed and back off without touching the winner's lock.
 *
 * The renewal timer is `setInterval(...).unref()`-ed so it does not
 * keep the Node/Bun runtime alive. Default renewal interval is
 * `max(1000, floor(ttlMs / 3))`.
 */
export type FileLockStep = 'stale-marker-stat' | 'stale-marker-claimed' | 'stale-lock-confirmed' | 'eviction-marker-acquired' | 'renew-read' | 'renew-committed';
export interface FencedFileLockOptions {
    path: string;
    name: string;
    ttlMs: number;
    /**
     * Defaults to `true`. When false, no renewal timer is scheduled.
     */
    renew?: boolean;
    /**
     * Override the renewal cadence in milliseconds.
     * Defaults to `max(RENEW_MIN_INTERVAL_MS, floor(ttlMs / 3))`.
     */
    renewIntervalMs?: number;
    /**
     * Clock injection. Defaults to `Date.now`. Tests use this to
     * simulate elapsed time without waiting for real wall-clock ticks.
     */
    now?: () => number;
    /**
     * Hook invoked at well-defined milestones inside the eviction
     * protocol and the renewal tick. Used by tests to inject
     * interleavings and simulate racing contenders:
     *
     * - `renew-read` — after the renewal tick reads the lock payload,
     *   before the ownership checks and the temp-write/rename commit.
     * - `renew-committed` — after the renewal rename lands, before the
     *   verify-after-commit re-read.
     */
    onStep?: (step: FileLockStep) => Promise<void> | void;
}
export interface FencedFileLock {
    ownerId: string;
    assertOwned(): Promise<void>;
    release(): Promise<void>;
    /**
     * Resolves when the renewal loop detects the lock has been taken over
     * by another owner (or otherwise lost before `release()`). Resolves
     * immediately if the lock is already lost.
     */
    whenLost(): Promise<void>;
    hasLost(): boolean;
}
/**
 * Thrown by `assertOwned` when the lock file no longer carries our
 * ownerId or has expired.
 */
export declare class FileLockOwnershipError extends Error {
    readonly details: {
        path: string;
        expectedOwner: string;
        observedOwner?: string;
        observedExpiresAt?: number;
    };
    constructor(message: string, details: FileLockOwnershipError['details']);
}
export declare function acquireFencedFileLock(options: FencedFileLockOptions): Promise<FencedFileLock | null>;
//# sourceMappingURL=file-lock.d.ts.map