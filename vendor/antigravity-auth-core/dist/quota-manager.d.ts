/**
 * Harness-agnostic attributed quota manager.
 *
 * Owns the per-account quota cache, in-flight de-duplication, and exponential
 * backoff that backgrounds proactive quota refreshes. The manager has no host
 * dependencies — harnesses supply a `fetchAccountQuota` callback that returns
 * the already-attributed `AccountQuotaResult` (with `index`, `email`,
 * `updatedAccount`, etc.) so core stays harness-agnostic.
 *
 * Manual quota dialogs must force a refresh even when background refresh is
 * backed off; proactive refreshes must dedupe by stable account identity and
 * respect backoff. Account identity is supplied via `keyOf` so reorders/
 * removals of the underlying array do not invalidate cache entries.
 */
import type { AccountMetadataV3 } from './account-types.ts';
import type { AccountQuotaResult, GeminiCliQuotaSummary, QuotaGroup, QuotaSummary } from './quota-types.ts';
export declare const QUOTA_MANAGER_DEFAULT_BASE_BACKOFF_MS = 30000;
export declare const QUOTA_MANAGER_DEFAULT_MAX_BACKOFF_MS: number;
export declare const QUOTA_MANAGER_DEFAULT_TIMEOUT_MS = 10000;
/**
 * Signature for the harness-supplied quota fetch callback.
 *
 * `index`/`email`/`updatedAccount` come from the harness — the manager
 * preserves the harness's attribution and only injects status/error info
 * for disabled accounts and failed fetches.
 */
export type FetchAccountQuota = (account: AccountMetadataV3, signal: AbortSignal) => Promise<AccountQuotaResult>;
export interface QuotaManagerOptions {
    fetchAccountQuota: FetchAccountQuota;
    /**
     * Stable identity for an account. Used as cache key + backoff key. Should
     * NOT be the array index — reorders and removals would otherwise corrupt
     * cached state. The harness can hash the refresh token or compose email +
     * a refresh-token fallback.
     */
    keyOf: (account: AccountMetadataV3) => string;
    now?: () => number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    /** Per-fetch active timeout for the harness callback. */
    fetchTimeoutMs?: number;
}
export interface RefreshAccountOptions {
    /** Position of the account in the harness-visible array. Preserved on result. */
    index: number;
    /** Bypass backoff (used by manual quota dialogs). */
    force?: boolean;
}
export interface RefreshAccountsOptions {
    indexFor: (account: AccountMetadataV3) => number;
    force?: boolean;
}
export interface QuotaManager {
    refreshAccount(account: AccountMetadataV3, options: RefreshAccountOptions): Promise<AccountQuotaResult>;
    refreshAccounts(accounts: AccountMetadataV3[], options: RefreshAccountsOptions): Promise<AccountQuotaResult[]>;
    getCached(account: AccountMetadataV3): AccountQuotaResult | undefined;
    getBackoffUntil(account: AccountMetadataV3): number;
    /** Stable hash for an account, used for log labels. */
    hashedLogLabel(prefix: string, account: AccountMetadataV3 | string): string;
    /**
     * Await any in-flight refresh, then cancel and reject subsequent
     * refreshes. Returns a promise so a lifecycle producer can fence its
     * fire-and-forget sidebar writes: awaiting `dispose()` guarantees no
     * refresh is still mid-flight (and therefore cannot enqueue a write)
     * once it resolves.
     */
    dispose(): Promise<void>;
    /** Pure helpers exposed for tests and adapter wiring. */
    classifyQuotaGroup: typeof classifyQuotaGroup;
    aggregateQuota: typeof aggregateQuota;
    aggregateGeminiCliQuota: typeof aggregateGeminiCliQuota;
}
/**
 * Default keyOf — prefers email, falls back to refresh-token hash so the
 * same identity is keyed even when emails are missing.
 */
export declare function defaultKeyOf(account: AccountMetadataV3): string;
export declare function createQuotaManager(options: QuotaManagerOptions): QuotaManager;
/**
 * Classify a model into its quota group.
 */
export declare function classifyQuotaGroup(modelName: string, displayName?: string): QuotaGroup | null;
export interface FetchAvailableModelEntry {
    quotaInfo?: {
        remainingFraction?: number;
        resetTime?: string;
    };
    displayName?: string;
    modelName?: string;
}
/**
 * Aggregate per-model quota entries into group summaries + per-model list.
 *
 * Pure helper — exposed for harness adapters that want to reuse the same
 * aggregation logic without re-implementing it.
 */
export declare function aggregateQuota(models?: Record<string, FetchAvailableModelEntry>): QuotaSummary;
export interface RetrieveUserQuotaBucket {
    remainingAmount?: string;
    remainingFraction?: number;
    resetTime?: string;
    tokenType?: string;
    modelId?: string;
}
export interface RetrieveUserQuotaResponse {
    buckets?: RetrieveUserQuotaBucket[];
}
export interface FetchAvailableModelsResponse {
    models?: Record<string, FetchAvailableModelEntry>;
}
export interface RetrieveUserQuotaSummaryBucket {
    bucketId: string;
    displayName: string;
    window: 'weekly' | '5h';
    resetTime: string;
    remainingFraction: number;
    description?: string;
}
export interface RetrieveUserQuotaSummaryGroup {
    displayName: string;
    description?: string;
    buckets: RetrieveUserQuotaSummaryBucket[];
}
export interface RetrieveUserQuotaSummaryResponse {
    groups: RetrieveUserQuotaSummaryGroup[];
    description?: string;
}
/**
 * Aggregate a retrieveUserQuotaSummary response into a QuotaSummary.
 *
 * Each RUQS group maps to a pool via bucketId prefix. Within a pool,
 * windows are stored shortest-first (5h before weekly, etc.). The pool's
 * `remainingFraction`/`resetTime` derive from the most-constrained window.
 */
export declare function aggregateQuotaSummary(response: RetrieveUserQuotaSummaryResponse): QuotaSummary;
export interface FetchQuotaSummaryOptions {
    accessToken: string;
    /** Managed project ID. Falls back to regular projectId on 403. */
    managedProjectId?: string;
    /** Regular project ID — used as fallback when managedProjectId is missing or returns 403. */
    projectId?: string;
    endpoints: readonly string[];
    timeoutMs?: number;
    userAgent?: string;
    fetchVia?: (url: string, options: RequestInit, extra: {
        timeoutMs: number;
        signal?: AbortSignal | null;
    }) => Promise<Response>;
}
export interface FetchQuotaSummaryResult {
    summary: RetrieveUserQuotaSummaryResponse;
    /** True when the result came from the legacy fallback path. */
    fellBackToLegacy?: boolean;
}
/**
 * Fetch the windowed quota summary via `retrieveUserQuotaSummary`.
 *
 * Uses the same transport/UA/timeout conventions as `fetchAvailableModels`.
 * On a 429 or 5xx against one endpoint, falls through to the next entry
 * in `options.endpoints` (matching the legacy fetchers' failover
 * convention). On 403 with the managedProjectId, retries with the
 * regular projectId. If that also 403s, falls back to
 * `fetchAvailableModels` so quota never goes dark. On missing
 * managedProjectId, tries projectId first.
 */
export declare function fetchQuotaSummary(options: FetchQuotaSummaryOptions): Promise<FetchQuotaSummaryResult>;
/**
 * Aggregate Gemini CLI quota buckets into a summary.
 */
export declare function aggregateGeminiCliQuota(response: RetrieveUserQuotaResponse): GeminiCliQuotaSummary;
export interface FetchAvailableModelsOptions {
    accessToken: string;
    projectId: string;
    endpoints: readonly string[];
    timeoutMs?: number;
    userAgent?: string;
    /**
     * Override the transport used for the probe. Defaults to
     * `fetchWithActiveTimeout` so callers get the same stream-safe active-fetch
     * timeout that the rest of the core uses.
     */
    fetchVia?: (url: string, options: RequestInit, extra: {
        timeoutMs: number;
        signal?: AbortSignal | null;
    }) => Promise<Response>;
}
export declare function fetchAvailableModels(options: FetchAvailableModelsOptions): Promise<FetchAvailableModelsResponse>;
export interface FetchGeminiCliQuotaOptions {
    accessToken: string;
    projectId: string;
    endpoints: readonly string[];
    timeoutMs?: number;
    userAgent?: string;
    /**
     * Optional transport override. Production callers omit this; the e2e
     * harness and tests inject a stub. Mirrors `fetchQuotaSummary`'s seam.
     */
    fetchVia?: (url: string, options: RequestInit, extra: {
        timeoutMs: number;
    }) => Promise<Response>;
}
export declare function fetchGeminiCliQuota(options: FetchGeminiCliQuotaOptions): Promise<RetrieveUserQuotaResponse>;
//# sourceMappingURL=quota-manager.d.ts.map