/**
 * Lock-held account storage engine.
 *
 * Owns the on-disk schema for the multi-account pool (v4) plus every
 * migration from older versions, the load/merge/save primitives, and a
 * `mutateAccountStorage` entry point that holds a fenced file lock for
 * the duration of read-modify-write. Concurrent writes retry up to a
 * bounded schedule (`100, 200, 400, 800, 1000ms` with factor 2 / max 1000)
 * before surfacing a typed `AccountStorageLockContentionError`.
 *
 * Fail-closed semantics: when the accounts file exists but cannot be
 * read as a valid v4 (parse error, schema mismatch, unknown future
 * version, I/O error), `mutateAccountStorage` and `loadAccountStorage`
 * throw a typed `AccountStorageUnreadableError` instead of treating
 * the bad state as "empty pool" and overwriting the file on the next
 * write. A best-effort `.corrupt-<ISO-timestamp>` backup is created
 * before throwing so a future bug can never permanently destroy user
 * data. The backup itself never throws.
 *
 * This module is harness-agnostic: it does not own a path (the harness
 * adapter passes one in via `loadAccountStorage(path)`). The harness is
 * responsible for picking the right on-disk path and ensuring the parent
 * directory exists.
 */
import type { AccountStorageV3, AccountStorageV4, AnyAccountStorage } from './account-types.ts';
/**
 * Thrown when `mutateAccountStorage` exhausts its initial attempt plus
 * five retries against a lock that is still held. Surfaces a typed
 * signal harnesses can distinguish from transient I/O errors.
 */
export declare class AccountStorageLockContentionError extends Error {
    readonly details: {
        path: string;
        attempts: number;
    };
    constructor(message: string, details: AccountStorageLockContentionError['details']);
}
/**
 * Reason the on-disk accounts file could not be parsed as a usable v4.
 * Harnesses distinguish between `malformed-json` (the file is broken
 * JSON — possibly truncated), `invalid-shape` (JSON parsed but the
 * shape does not match the storage schema), `unsupported-version` (a
 * version newer than v4 that this build cannot migrate), and `io-error`
 * (a real I/O failure other than ENOENT — typically EACCES).
 */
export type AccountStorageUnreadableReason = 'malformed-json' | 'invalid-shape' | 'unsupported-version' | 'io-error';
/**
 * Thrown when the on-disk accounts file exists but cannot be read as
 * a valid v4. Distinguishes ENOENT (first-run UX: missing file is
 * fine) from "the file is there but we can't trust it" (fail closed).
 *
 * `backupPath` is set when a `.corrupt-<ISO-timestamp>` sidecar was
 * successfully written; consumers should mention it in any user-facing
 * recovery message so the user knows their data is preserved.
 */
export declare class AccountStorageUnreadableError extends Error {
    readonly details: {
        path: string;
        reason: AccountStorageUnreadableReason;
        detail: string;
        backupPath: string | null;
    };
    constructor(message: string, details: AccountStorageUnreadableError['details']);
}
export interface AccountStorageOptions {
    /**
     * Sleep override for deterministic retry timing in tests. Defaults to
     * a real `setTimeout`-based sleep.
     */
    sleep?: (ms: number) => Promise<void>;
    /**
     * Backup override for deterministic backup paths in tests. Defaults
     * to `path + '.corrupt-<ISO-timestamp>'` with the time captured at
     * call time. Returning `null` skips the backup.
     */
    buildBackupPath?: (path: string, now: Date) => string | null;
    /**
     * Clock override for deterministic timestamps in tests. Defaults to
     * `() => new Date()`.
     */
    now?: () => Date;
}
/**
 * Deduplicate accounts that share an email, keeping the entry with the
 * newest `lastUsed` then `addedAt`. Order of the kept entries in the
 * output array is determined by the position of the *newest* matching
 * account in the input array (not necessarily the original positions).
 */
export declare function deduplicateAccountsByEmail<T extends {
    email?: string;
    lastUsed?: number;
    addedAt?: number;
}>(accounts: T[]): T[];
export declare function migrateV2ToV3(v2: Extract<AnyAccountStorage, {
    version: 2;
}>): AccountStorageV3;
/**
 * Merge two v4 account pools keyed by `refreshToken`. Preserves
 * `projectId`/`managedProjectId` from either side when the incoming
 * payload omits them. Eligibility state survives via a per-field
 * `eligibilityStateUpdatedAt` comparison so a stale concurrent writer
 * cannot regress an explicit ineligible decision.
 */
export declare function mergeAccountStorage(existing: AccountStorageV4, incoming: AccountStorageV4): AccountStorageV4;
/**
 * Load the account pool from `path`, migrating older versions in-place
 * to v4 and persisting the migrated copy.
 *
 * Returns `null` when the file does not exist (first-run UX).
 *
 * Throws `AccountStorageUnreadableError` when the file exists but
 * cannot be read as a valid v4 — callers must NOT treat this as an
 * empty pool, or they will silently destroy the user's data on the
 * next write.
 */
export declare function loadAccountStorage(path: string): Promise<AccountStorageV4 | null>;
/**
 * Run `mutate` against the freshest persisted pool while holding the
 * file lock. The mutator may return a partial v4 (or `undefined` to
 * keep the input unchanged) and is guaranteed to see the post-migration
 * v4 shape.
 *
 * Throws `AccountStorageLockContentionError` after exhausting the
 * retry schedule against a lock that is still held by another writer.
 *
 * Throws `AccountStorageUnreadableError` when the file exists but
 * cannot be read as a valid v4. In that case the file is first copied
 * to a `.corrupt-<ISO-timestamp>` sidecar (best-effort) and the write
 * is aborted — a user with a corrupt-but-recoverable accounts file (or
 * one written by a newer plugin version) who adds one account MUST NOT
 * have their entire pool silently destroyed.
 */
export declare function mutateAccountStorage(path: string, mutate: (current: AccountStorageV4) => AccountStorageV4 | undefined | Promise<AccountStorageV4 | undefined>, options?: AccountStorageOptions): Promise<AccountStorageV4>;
/**
 * Merge `incoming` into the persisted pool under the lock. Returns the
 * merged v4 result that was written to disk.
 */
export declare function saveAccountStorage(path: string, incoming: AccountStorageV4): Promise<AccountStorageV4>;
/**
 * Write `incoming` to disk unconditionally (no merge). Required for
 * destructive operations like delete where the next-state must replace
 * — never be merged with — what is on disk.
 */
export declare function saveAccountStorageReplace(path: string, incoming: AccountStorageV4): Promise<AccountStorageV4>;
/**
 * Unlink the persisted pool while holding the lock so a concurrent
 * debounced save cannot resurrect the pool mid-clear. Missing files are
 * treated as a successful no-op (matches the legacy semantics).
 */
export declare function clearAccountStorage(path: string): Promise<void>;
/**
 * Bundle the harness-facing storage primitives. Used by `AccountManager`
 * so tests can inject a fake store without going through the filesystem.
 */
export interface AccountStorageStore {
    load: (path: string) => Promise<AccountStorageV4 | null>;
    saveMerged: (path: string, next: AccountStorageV4) => Promise<AccountStorageV4>;
    mutate: (path: string, fn: (current: AccountStorageV4) => AccountStorageV4 | undefined | Promise<AccountStorageV4 | undefined>, options?: AccountStorageOptions) => Promise<AccountStorageV4>;
    clear: (path: string) => Promise<void>;
}
export declare const defaultAccountStorageStore: AccountStorageStore;
//# sourceMappingURL=account-storage.d.ts.map