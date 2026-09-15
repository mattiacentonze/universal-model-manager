import { ACCOUNT_FILE_NAME, ACCOUNT_STATE_FILE_NAME, deriveStatePath, getAccountStatePath, getAccountStoragePath } from './account-paths';
import type { ProviderQuotaFn, ProviderRefreshFn, QuotaWindowName } from './provider.ts';
import { PRIMARY, SECONDARY } from './provider.ts';
export { ACCOUNT_FILE_NAME, ACCOUNT_STATE_FILE_NAME, deriveStatePath, getAccountStatePath, getAccountStoragePath, };
export type { QuotaWindowName };
export { PRIMARY, SECONDARY };
export type AccountQuotaWindow = {
    usedPercent: number;
    remainingPercent: number;
    resetsAt?: string;
    checkedAt: number;
    windowMinutes?: number;
};
export interface OAuthQuotaSnapshot {
    primary?: AccountQuotaWindow;
    secondary?: AccountQuotaWindow;
    resetCreditsAvailable?: number;
    resetCreditsApplicable?: number;
}
export type AccountBase = {
    id: string;
    label?: string;
    enabled?: boolean;
    addedAt?: number;
    lastUsed?: number;
    /** Stable ChatGPT account identifier extracted from the OAuth token claims. */
    accountId?: string;
};
export type AccountOperationError = {
    message: string;
    checkedAt: number;
    nextRetryAt?: number;
    retryCount?: number;
    tokenHash?: string;
};
export type OAuthAccount = AccountBase & {
    type: 'oauth';
    access?: string;
    refresh: string;
    expires?: number;
    lastRefreshedAt?: number;
    lastRefreshError?: AccountOperationError;
    lastQuotaRefreshError?: AccountOperationError;
    quota?: OAuthQuotaSnapshot;
};
export type ApiKeyAccount = AccountBase & {
    type: 'api';
    apiKey?: string;
    baseURL: string;
    authHeader?: 'authorization-bearer' | 'x-api-key';
};
export type FallbackAccount = OAuthAccount | ApiKeyAccount;
export declare function isOAuthAccount(account: FallbackAccount): account is OAuthAccount;
export declare function isApiKeyAccount(account: FallbackAccount): account is ApiKeyAccount;
export declare function isValidApiBaseURL(value: string | undefined): boolean;
export type RoutingMode = 'main-first' | 'fallback-first' | 'sticky-balanced';
export type KillswitchThresholds = Partial<Record<QuotaWindowName | '5h' | '1w', number>>;
export type KillswitchConfig = {
    enabled?: boolean;
    main?: KillswitchThresholds;
    accounts?: Record<string, KillswitchThresholds>;
};
export interface ResetInFlight {
    redeemRequestId: string;
    creditId: string;
    startedAt: number;
}
export interface ResetLastOutcome {
    code: string;
    at: number;
    previousOutcome?: {
        code: string;
        at: number;
    };
}
export interface ResetAccountState {
    inFlight?: ResetInFlight | Record<string, unknown>;
    lastOutcome?: ResetLastOutcome;
    cooldownUntil?: number;
}
export type ResetStateByAccount = Record<string, ResetAccountState>;
export type AccountStorage = {
    version: 1;
    main?: {
        type: 'opencode';
        provider: 'openai';
    };
    routing?: {
        mode?: RoutingMode;
    };
    fallbackOn?: number[];
    refresh?: {
        enabled?: boolean;
        intervalMinutes?: number;
        refreshBeforeExpiryMinutes?: number;
        mainLastRefreshError?: AccountOperationError;
        mainRefreshLeaseId?: string;
        mainRefreshLeaseUntil?: number;
        mainRefreshLeaseTokenHash?: string;
    };
    quota?: {
        enabled?: boolean;
        checkIntervalMinutes?: number;
        refreshEveryNRequests?: number;
        minimumRemaining?: Partial<Record<QuotaWindowName | '5h' | '1w', number>>;
        failClosedOnUnknownQuota?: boolean;
        showToasts?: boolean;
        mainQuota?: OAuthQuotaSnapshot;
        mainQuotaCheckedAt?: number;
        mainQuotaToken?: string;
        mainLastQuotaApiError?: AccountOperationError;
    };
    reset?: ResetStateByAccount;
    dump?: {
        enabled?: boolean;
    };
    costZeroing?: {
        enabled?: boolean;
    };
    killswitch?: KillswitchConfig;
    logging?: {
        level?: string;
    };
    cachekeep?: {
        enabled?: boolean;
        subagents?: boolean;
        sustain?: boolean;
        /** Clock-hour window start (0-23, inclusive) — keeps cachekeep idle warming
         *  inside `[startHour, endHour)` local hours. Omit to warm unconditionally. */
        startHour?: number;
        /** Clock-hour window end (0-23, exclusive) — must differ from startHour
         *  to be honored; an unset or equal hour falls back to "always warm". */
        endHour?: number;
    };
    /** Stable ChatGPT account identifier of the main account (extracted from OAuth token). */
    mainAccountId?: string;
    accounts: FallbackAccount[];
};
export declare function isCostZeroingEnabled(storage: Pick<AccountStorage, 'costZeroing'>): boolean;
export type AccountRuntimeEntry = Partial<Pick<OAuthAccount, 'access' | 'refresh' | 'expires' | 'lastUsed' | 'lastRefreshedAt' | 'lastRefreshError' | 'lastQuotaRefreshError' | 'quota'> & Pick<ApiKeyAccount, 'apiKey' | 'lastUsed'>>;
export type AccountRuntimeState = {
    version: 1;
    main?: {
        quota?: OAuthQuotaSnapshot;
        quotaCheckedAt?: number;
        quotaToken?: string;
        lastQuotaApiError?: AccountOperationError;
        lastRefreshError?: AccountOperationError;
        refreshLeaseId?: string;
        refreshLeaseUntil?: number;
        refreshLeaseTokenHash?: string;
    };
    accounts?: Record<string, AccountRuntimeEntry>;
};
export type AccountStateSaveScope = {
    mainQuota?: boolean;
    mainRefresh?: boolean;
    accounts?: true | string[];
};
export type AccountManagerOptions = {
    now?: () => number;
    fetchImpl?: typeof fetch;
    configPath?: string;
    onFallbackStorageChanged?: () => void;
    /** Provider token-refresh function (constructor-injected). */
    refreshFn?: ProviderRefreshFn;
    /** Provider quota-fetch function (constructor-injected, OPTIONAL wham/usage supplement). */
    fetchQuotaFn?: ProviderQuotaFn;
    /** QuotaManager instance for unified cache (constructor-injected). */
    quotaManager?: import('./quota-manager.ts').QuotaManager;
};
export type AccountRefreshError = {
    accountId: string;
    message: string;
};
export declare class AccountRemovedDuringRefreshError extends Error {
    readonly code = "ACCOUNT_REMOVED_DURING_REFRESH";
    constructor(accountId: string);
}
export declare const DEFAULT_KILLSWITCH_THRESHOLDS: {
    primary: number;
    secondary: number;
};
export declare function isSafeResetAccountKey(accountKey: string): boolean;
/**
 * The set of account ids present in the CONFIG file (the authoritative account
 * roster). Returns null when the config is absent or unreadable/malformed, so
 * callers can fall back to non-pruning behavior rather than risk wiping live
 * state. The config never holds secrets (see accountConfig), so reading it here
 * is safe. Reads are lock-free but the file is written atomically, so a
 * concurrent write is seen as either the complete old or complete new file.
 *
 * Trims and skips blank ids per the rule in collectConfigRosterIds above.
 */
export declare function readConfigRosterIds(path: string): Promise<Set<string> | null>;
export declare function loadAccounts(path?: string): Promise<AccountStorage | null>;
export declare function saveAccounts(storage: AccountStorage, path?: string): Promise<void>;
/**
 * Read-modify-write the account store atomically under the save lock.
 *
 * Unlike saveAccounts (which UNION-merges the incoming accounts with the latest
 * on-disk set so concurrent ADDS from another process are never lost), this
 * reads the freshest state under the lock and writes the mutator's result
 * AUTHORITATIVELY — no union. That is required for structural edits (remove,
 * reorder): a union cannot express a deletion (the removed id reappears from
 * `latest`) or a reordering (the union is seeded latest-first). Because the
 * mutator runs against freshly-read state under the lock, an add committed by a
 * concurrent process is still visible to it and preserved.
 *
 * The mutator may edit `current` in place and return it, or return a new
 * storage object. Returning undefined means "no change" and still rewrites the
 * freshly-read state (a harmless idempotent write).
 *
 * Load-time drop preservation: if normalizeAccount (called inside
 * normalizeStorage) rejects an account whose id IS in the raw config roster,
 * the previous behavior would erase that id silently on the next write. This
 * function now carries the dropped raw entry through to the written config
 * verbatim, so the on-disk state always matches the operator's intent (an
 * account they added, even if temporarily un-loadable, stays in their list
 * until they deliberately remove it).
 *
 * Removal seam: when the caller knows they are removing an id (e.g. the CLI
 * `remove` command) and that id may be load-dropped — in which case the
 * mutator cannot find it in `current.accounts` to splice it — the caller can
 * pass `options.allowDrop: [id]`. Ids in `allowDrop` are NOT preserved; the
 * mutator's splice still no-ops on a dropped id, but the absence of
 * preservation completes the removal end-to-end.
 */
export declare function mutateAccounts(mutate: (current: AccountStorage) => AccountStorage | undefined, path?: string, options?: {
    allowDrop?: readonly string[];
}): Promise<AccountStorage>;
export declare function saveAccountState(storage: AccountStorage, path?: string, scope?: AccountStateSaveScope): Promise<void>;
export declare function shouldFallbackStatus(status: number, storage: AccountStorage | null): boolean;
export declare function quotaSnapshotPassesPolicy(quota: OAuthQuotaSnapshot | undefined, storage: AccountStorage | null, now?: number): boolean;
export declare function isKillswitchEnabled(storage: AccountStorage | null): boolean;
export declare function getKillswitchThresholdsForAccount(storage: AccountStorage | null, accountId?: string): {
    primary: number;
    secondary: number;
};
export declare function killswitchPassesPolicy(quota: OAuthQuotaSnapshot | undefined, storage: AccountStorage | null, accountId?: string, now?: number): boolean;
export declare function killswitchRetryAfterSeconds(mainQuota: OAuthQuotaSnapshot | undefined, fallbackAccounts: Array<{
    accountId: string;
    quota?: OAuthQuotaSnapshot;
}>, now: number, storage: AccountStorage | null): number;
/**
 * Migrate an existing single-slot token into the multi-account store.
 *
 * Reads the existing token via the caller-provided `getAuth` (the ONLY
 * read path — there is no `client.auth.get`). If a token exists and the
 * config file is NOT yet an account store (content discriminator), seeds
 * it as the primary OAuth account.
 *
 * Idempotent: a second run is a no-op because the content discriminator
 * will already match.
 *
 * Tolerates expired/revoked tokens (migrates them; refresh handles validity).
 *
 * Guards against first-run races with the same save-lock order used by
 * structural account mutations.
 */
export declare function migrateIfNeeded(existingToken: {
    type: 'oauth';
    access: string;
    refresh: string;
    expires: number;
} | undefined, path?: string): Promise<void>;
export declare function getQuotaCheckIntervalMs(storage: AccountStorage | null): number;
export declare function getRefreshIntervalMs(storage: AccountStorage | null): number;
export declare class FallbackAccountManager {
    private readonly now;
    private readonly fetchImpl;
    private readonly configPath;
    private readonly refreshPromises;
    private refreshTimer;
    private quotaTimer;
    readonly quotaManager: import('./quota-manager.ts').QuotaManager | null;
    private readonly onFallbackStorageChanged;
    private readonly options;
    constructor(options?: AccountManagerOptions);
    /**
     * Seed QuotaManager from persisted account.quota if no cache entry exists
     * yet. Prevents unnecessary API calls when the on-disk snapshot is fresh.
     */
    private seedFallbackQuota;
    load(): Promise<AccountStorage | null>;
    save(storage: AccountStorage, accountIds?: string[]): Promise<void>;
    startBackgroundRefresh(): void;
    stopBackgroundRefresh(): void;
    getUsableFallbackAccounts(existingStorage?: AccountStorage | null): Promise<OAuthAccount[]>;
    /**
     * Stamp `lastUsed` on a served account.
     *
     * This runs on the request path after a response is already in hand, and
     * `lastUsed` is telemetry: nothing reads it to make a routing, quota, or
     * killswitch decision. The WHOLE operation is therefore best-effort, read
     * included — loadAccounts deliberately rethrows anything that is not ENOENT so
     * corruption surfaces to callers that must act on it, and a store lock shared
     * by every session in the host process can legitimately time out under a burst
     * of concurrent turns. Neither may reach this caller: it would discard a
     * successful, already-billed provider response to record a timestamp. Losing
     * the stamp costs nothing a later turn cannot redo.
     *
     * Contrast refreshAccount, whose save persists rotated tokens and MUST
     * propagate: dropping it silently would strand a refresh and invalidate the
     * account's credentials.
     */
    markUsed(account: FallbackAccount): Promise<void>;
    accountPassesQuotaPolicy(account: OAuthAccount, storage: AccountStorage | null): boolean;
    /**
     * Return the account with its quota overlaid from the unified QuotaManager
     * cache (token-bound) when available, so quota-policy decisions use the same
     * source of truth as the staleness check. Falls back to the stored
     * account.quota when no manager is wired or the cache has no entry.
     */
    private quotaPolicyAccount;
    refreshDueAccounts(): Promise<void>;
    refreshQuotaForDueAccounts(): Promise<void>;
    refreshQuotaForAllAccounts(options?: {
        force?: boolean;
    }): Promise<{
        storage: AccountStorage | null;
        errors: AccountRefreshError[];
    }>;
    refreshAccount(account: OAuthAccount, storage: AccountStorage, options?: {
        force?: boolean;
    }): Promise<OAuthAccount>;
    private waitForConcurrentFallbackRefresh;
    private refreshAccountNow;
    refreshAccountQuota(account: OAuthAccount, storage: AccountStorage): Promise<void>;
}
