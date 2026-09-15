/**
 * Unified quota cache and API gateway.
 *
 * Single source of truth for main + fallback quota state. All consumers
 * share one QuotaManager instance so they see the same in-memory cache.
 * Handles deduplication, rate-limiting (429 backoff), and staleness.
 *
 * Adapted from anthropic-auth — provider-specific quota fetch injected via
 * fetchQuotaFn instead of hard-importing fetchOAuthQuotaSnapshot.
 */
import type { AccountOperationError, AccountQuotaWindow, AccountStorage, OAuthAccount, OAuthQuotaSnapshot } from './accounts.ts';
import { type ProviderQuotaFn } from './provider.ts';
export type { ProviderQuotaFn };
export declare function quotaWindowResetIsPast(window: AccountQuotaWindow | undefined, now: number): boolean;
/**
 * Resolve when a WS-exhausted account becomes usable. Admission errors can
 * carry the provider's authoritative reset; response.failed frames do not, so
 * those fall back to the named window in the last-known quota snapshot. Never
 * borrow the other window's reset — an unrelated window can blackhole the
 * account long past its actual limit. The bounded default self-corrects when a
 * later request reports exhaustion again.
 */
export declare function resolveMidStreamRateLimitResetAt(quota: OAuthQuotaSnapshot | undefined, window: string, now: number, defaultMs: number, explicitResetAt?: number): number;
/**
 * Stable, non-reversible fingerprint of an access token. Used to detect a
 * main-account switch so a different account's persisted/cached quota is never
 * reused. Not a secret — a truncated SHA-256, safe to persist alongside quota.
 */
export declare function tokenFingerprint(token: string): string;
export type QuotaEntry = {
    quota: OAuthQuotaSnapshot;
    refreshAfter: number;
    checkedAt: number;
    accountId?: string;
};
export type QuotaManagerOptions = {
    storage: AccountStorage | null;
    fetchImpl?: typeof fetch;
    now?: () => number;
    /** Injected quota-fetch function — replaces the hard-imported Anthropic fetchOAuthQuotaSnapshot */
    fetchQuotaFn?: ProviderQuotaFn;
    onMainQuotaFetched?: (quota: OAuthQuotaSnapshot, checkedAt: number, fingerprint: string, fetchStartedAt: number) => void;
    onApiError?: (error: AccountOperationError) => void;
};
export declare class QuotaManager {
    private main;
    private mainTokenFp;
    private mainQuotaAccountId;
    private fallbacks;
    private fallbackTokenFps;
    private inflightMain;
    private inflightMainFp;
    private inflightFallbacks;
    private mainLastApiError;
    private fallbackApiErrors;
    private fallbackErrorTokenFps;
    private rateLimitedUntilMap;
    private apiGate;
    private lastApiCallAt;
    private storage;
    private readonly fetchImpl;
    private readonly now;
    private readonly fetchQuotaFn;
    private readonly onMainQuotaFetched;
    private readonly onApiError;
    constructor(opts: QuotaManagerOptions);
    /**
     * Cached main quota entry. Pass the live access token to enforce token
     * binding: if the cached entry was produced by a different token (main
     * account switched), it is dropped and null is returned so the caller
     * refetches for the current account. Called without a token (e.g. for
     * display) it returns whatever is cached.
     */
    getMain(accessToken?: string): QuotaEntry | null;
    /**
     * Cached fallback quota entry. Pass the live access token to enforce token
     * binding: if the entry was produced by a different token (account re-login),
     * it is dropped and null is returned so the caller refetches.
     */
    getFallback(accountId: string, accessToken?: string): QuotaEntry | null;
    getAllFallbacks(): Map<string, QuotaEntry>;
    setMain(accessToken: string, entry: QuotaEntry, accountId?: string, completeSnapshot?: boolean): void;
    /**
     * Non-invalidating read of the cached main quota for POLICY decisions
     * (killswitch). Unlike getMain(token), a token mismatch does NOT drop the
     * cache — an access-token refresh is a same-account event and must not turn a
     * known-exhausted account into "unknown" (which would fail open and spend).
     *
     * Pass the live ChatGPT accountId to still drop on a genuine account SWITCH:
     * if the cached entry's account identity is known and differs, return null so
     * the killswitch treats it as unknown rather than judging account A by account
     * B's quota. When identity is unknown on either side, the cached snapshot is
     * returned (best-effort) — the same fail-open-on-unknown stance as elsewhere.
     */
    peekMainForPolicy(accountId?: string): QuotaEntry | null;
    /**
     * Non-invalidating read of a cached fallback quota for POLICY decisions
     * (killswitch, admission). Keyed by the stable internal account id, so a
     * token refresh for the same account does not drop it (getFallback(id, token)
     * would).
     *
     * Pass the live ChatGPT identity to still drop on a genuine re-login: if the
     * cached entry's identity is known and differs, return null so the previous
     * identity's (possibly exhausted) quota is never judged against its
     * replacement. Unknown on either side fails open, matching peekMainForPolicy.
     */
    peekFallbackForPolicy(accountId: string, identity?: string): QuotaEntry | null;
    setFallback(accountId: string, entry: QuotaEntry, accessToken?: string, completeSnapshot?: boolean, identity?: string): void;
    /**
     * Mark accountId ('main' or a fallback id) rate-limited until resetAtMs.
     * Keeps the LATER reset: skips only when an existing mark is strictly
     * later than resetAtMs, so an equal-reset re-mark still applies (idempotent)
     * instead of being silently dropped by a stale `>=` comparison.
     */
    markRateLimited(accountId: string, resetAtMs: number): void;
    /** True iff accountId has a mark whose reset has not yet passed. */
    isRateLimited(accountId: string): boolean;
    /**
     * Raw stored reset for accountId's mark, or undefined if none. Unlike
     * isRateLimited, this does NOT apply read-time expiry — callers on the
     * block path already know the mark is live (isRateLimited just returned
     * true) and want its exact reset estimate for a Retry-After computation.
     */
    rateLimitedUntil(accountId: string): number | undefined;
    /** Explicit early clear — read-time expiry in isRateLimited is primary. */
    clearRateLimited(accountId: string): void;
    refreshMain(accessToken: string): Promise<OAuthQuotaSnapshot>;
    refreshFallback(accountId: string, accessToken: string): Promise<OAuthQuotaSnapshot>;
    refreshAllFallbacks(accounts: OAuthAccount[]): Promise<void>;
    /**
     * Fire-and-forget refresh. Does not await, swallows errors.
     */
    refreshMainInBackground(accessToken: string): void;
    isMainStale(): boolean;
    isFallbackStale(accountId: string, accessToken?: string): boolean;
    shouldRefreshOnRequestCount(requestCount: number): boolean;
    /**
     * Combined check: should a refresh happen right now?
     * True if main is stale by time OR triggered by request count.
     */
    needsRefresh(requestCount: number): boolean;
    updateStorage(storage: AccountStorage | null): void;
    /**
     * Seed/update the main quota cache from persisted state. This is deliberately
     * callable after every disk load so another plugin process's fresh quota write
     * can stop this process from showing "checking…" or making a redundant quota
     * API call.
     */
    seedMainFromStorage(storage: AccountStorage | null, accessToken?: string): void;
    private seedMainBackoffFromStorage;
    /**
     * Seed fallback cache entries from persisted account.quota data.
     * Updates older in-memory entries so a fresh quota write from another plugin
     * process prevents redundant checks and stale sidebar writes.
     */
    seedFallbacksFromAccounts(accounts: OAuthAccount[]): void;
    /**
     * Whether the MAIN quota API is currently in backoff. Scoped to the main
     * account — a fallback account's 429 never reports here.
     */
    isBackedOff(): boolean;
    /**
     * Whether a specific fallback account's quota API is in backoff.
     */
    isFallbackBackedOff(accountId: string, accessToken?: string): boolean;
    getLastApiError(): AccountOperationError | undefined;
    /** Minimum gap between consecutive quota API calls (ms). */
    private static readonly API_CALL_GAP_MS;
    private static fallbackInflightKey;
    private static quotaLockName;
    /**
     * Serialize API calls through a shared gate so only one
     * quota API request runs at a time, with a minimum gap
     * between calls. Prevents concurrent and rapid-fire calls
     * from triggering rate limits.
     */
    private _enqueueApiFetch;
    private _fetchMain;
    private _fetchFallback;
    /** Route through injected fetchQuotaFn, or throw if unset. */
    private _fetchQuota;
    private static isAuthError;
    /** Main quota failure: arms main-only backoff and persists via onApiError. */
    private _handleMainFetchError;
    /**
     * Fallback quota failure: arms backoff for THIS account only. Never touches
     * main backoff state and never calls onApiError (which persists the main
     * quota error) — the per-account error is recorded by the caller via the
     * account's lastQuotaRefreshError.
     */
    private _handleFallbackFetchError;
}
