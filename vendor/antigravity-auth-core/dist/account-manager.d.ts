import type { AccountStorageStore } from './account-storage.ts';
import type { AccountMetadataV3, AccountSelectionStrategy, AccountStorageV4, CooldownReason, HeaderStyle, AccountModelFamily as ModelFamily, RateLimitStateV3 } from './account-types.ts';
import type { OAuthAuthDetails, RefreshParts } from './auth-types.ts';
import { type Fingerprint, type FingerprintVersion } from './fingerprint.ts';
import { type QuotaGroup, type QuotaGroupSummary } from './quota-types.ts';
export type { AccountSelectionStrategy, CooldownReason, HeaderStyle, ModelFamily, };
export interface AccountManagerOptions {
    store: AccountStorageStore;
    storagePath?: string;
    now?: () => number;
    random?: () => number;
    pid?: number;
    onDiagnostic?: (message: string, fields?: Record<string, unknown>) => void;
}
export type { RateLimitReason } from './rotation.ts';
export { calculateBackoffMs, computeSoftQuotaCacheTtlMs, parseRateLimitReason, } from './rotation.ts';
import type { RateLimitReason } from './rotation.ts';
export type BaseQuotaKey = 'claude' | 'gemini-antigravity' | 'gemini-cli';
export type QuotaKey = BaseQuotaKey | `${BaseQuotaKey}:${string}`;
export interface ManagedAccount {
    index: number;
    email?: string;
    label?: string;
    addedAt: number;
    lastUsed: number;
    parts: RefreshParts;
    /** Authoritative project ID from the persisted account record. Survives
     * bare-refresh-token rotations where `parts.projectId` may be lost. */
    projectId?: string;
    /** Authoritative managed project ID from the persisted account record.
     * Survives bare-refresh-token rotations where `parts.managedProjectId`
     * may be lost. */
    managedProjectId?: string;
    access?: string;
    expires?: number;
    enabled: boolean;
    rateLimitResetTimes: RateLimitStateV3;
    lastSwitchReason?: 'rate-limit' | 'initial' | 'rotation';
    coolingDownUntil?: number;
    cooldownReason?: CooldownReason;
    touchedForQuota: Record<string, number>;
    consecutiveFailures?: number;
    /** Timestamp of last failure for TTL-based reset of consecutiveFailures */
    lastFailureTime?: number;
    /** Per-account device fingerprint for rate limit mitigation */
    fingerprint?: import('./fingerprint').Fingerprint;
    /** History of previous fingerprints for this account */
    fingerprintHistory?: FingerprintVersion[];
    /** Cached quota data from last checkAccountsQuota() call */
    cachedQuota?: Partial<Record<QuotaGroup, QuotaGroupSummary>>;
    /** Opaque identity of the refresh token that produced `cachedQuota`. */
    cachedQuotaAccountId?: string;
    cachedQuotaUpdatedAt?: number;
    /**
     * Captured plan tier ID from the most recent `loadCodeAssist` response.
     * Raw upstream string (e.g. `"free-tier"`) — never normalised.
     */
    capturedTierId?: string;
    /** Raw paid-tier ID from the most recent `loadCodeAssist` response. */
    capturedPaidTierId?: string;
    /** Epoch ms when `capturedTierId` was last recorded. */
    capturedTierAt?: number;
    /** Schema version of the most recent tier capture, even when paid tier is absent. */
    capturedTierSchemaVersion?: number;
    verificationRequired?: boolean;
    verificationRequiredAt?: number;
    verificationRequiredReason?: string;
    verificationUrl?: string;
    accountIneligible?: boolean;
    accountIneligibleAt?: number;
    accountIneligibleReason?: string;
    eligibilityStateUpdatedAt?: number;
    /** Daily request counts per model family */
    dailyRequestCounts?: {
        date: string;
        claude: number;
        gemini: number;
    };
}
/**
 * Resolve the quota group for soft quota checks.
 *
 * When a model string is available we use the model-registry lookup first,
 * then fall back to substring matching. When model is null/undefined we
 * fall back based on family:
 * - Claude → "non-gemini" quota group
 * - Gemini → "gemini" quota group
 *
 * @param family - The model family ("claude" | "gemini")
 * @param model - Optional model string for precise resolution
 * @returns The QuotaGroup to use for soft quota checks
 */
export declare function resolveQuotaGroup(family: ModelFamily, model?: string | null): QuotaGroup;
export interface AccountSessionIdentity {
    id: string;
    parentId?: string | null;
}
/**
 * In-memory multi-account manager with sticky account selection.
 *
 * Uses the same account until it hits a rate limit (429), then switches.
 * Rate limits are tracked per-model-family (claude/gemini) so an account
 * rate-limited for Claude can still be used for Gemini.
 *
 * Source of truth for the pool is `antigravity-accounts.json`.
 */
export declare class AccountManager {
    private accounts;
    private cursorByFamily;
    private currentAccountIndexByFamily;
    private sessionOffsetApplied;
    private lastToastAccountIndex;
    private lastToastTime;
    private savePending;
    private saveTimeout;
    private saveInFlight;
    private disposed;
    private savePromiseResolvers;
    private sessionStartTime;
    private sessionRequestCounts;
    private sessionUsedAccounts;
    private requestSessionStates;
    private readonly store;
    private readonly storagePath;
    private readonly onDiagnostic;
    private readonly now;
    private readonly random;
    private readonly pid;
    constructor(authFallback: OAuthAuthDetails | undefined, stored: AccountStorageV4 | null | undefined, options: AccountManagerOptions);
    getAccountCount(): number;
    getTotalAccountCount(): number;
    getEnabledAccounts(): ManagedAccount[];
    private getEffectiveSoftQuotaThreshold;
    getAccountsSnapshot(): ManagedAccount[];
    private getRequestSessionState;
    private pruneRequestSessionStates;
    private getActiveIndex;
    private setActiveIndex;
    private getCursor;
    private advanceCursor;
    private getUsedAccounts;
    private preferAccountOutsideParent;
    deleteSessionState(sessionId: string): void;
    getCurrentAccountForFamily(family: ModelFamily, identity?: AccountSessionIdentity): ManagedAccount | null;
    /**
     * Numeric active indexes for each model family. Exposed so callers
     * that persist `activeIndexByFamily` (e.g. command-data's remove
     * path) can capture the live cursor per family without going
     * through the account-lookup layer.
     */
    getActiveIndexByFamily(identity?: AccountSessionIdentity): Record<ModelFamily, number>;
    markSwitched(account: ManagedAccount, reason: 'rate-limit' | 'initial' | 'rotation', family: ModelFamily, identity?: AccountSessionIdentity): void;
    /**
     * Check if we should show an account switch toast.
     * Debounces repeated toasts for the same account.
     */
    shouldShowAccountToast(accountIndex: number, debounceMs?: number): boolean;
    markToastShown(accountIndex: number): void;
    getCurrentOrNextForFamily(family: ModelFamily, model?: string | null, strategy?: AccountSelectionStrategy, headerStyle?: HeaderStyle, pidOffsetEnabled?: boolean, softQuotaThresholdPercent?: number, softQuotaCacheTtlMs?: number, identity?: AccountSessionIdentity, 
    /**
     * Account indexes the caller has ruled out (e.g. the operator
     * killswitch pre-filter). Every selection path — pinned session,
     * round-robin, hybrid, and sticky fallback — skips these indexes
     * so a killed current account falls through to the next eligible
     * account instead of collapsing the request into the rate-limit
     * wait path.
     */
    excludeIndexes?: Set<number>): ManagedAccount | null;
    getNextForFamily(family: ModelFamily, model?: string | null, headerStyle?: HeaderStyle, softQuotaThresholdPercent?: number, softQuotaCacheTtlMs?: number, identity?: AccountSessionIdentity, 
    /** Indexes ruled out by the caller (e.g. killswitch pre-filter). */
    excludeIndexes?: Set<number>): ManagedAccount | null;
    markRateLimited(account: ManagedAccount, retryAfterMs: number, family: ModelFamily, headerStyle?: HeaderStyle, model?: string | null): void;
    /**
     * Mark an account as used after a successful API request.
     * This updates the lastUsed timestamp for freshness calculations.
     * Should be called AFTER request completion, not during account selection.
     */
    markAccountUsed(accountIndex: number): void;
    recordSessionUsage(accountIndex: number, identity?: AccountSessionIdentity): void;
    wasUsedInSession(accountIndex: number, identity?: AccountSessionIdentity): boolean;
    shouldProactivelyRotate(family: ModelFamily, model: string | null | undefined, thresholdPercent: number, cacheTtlMs: number, identity?: AccountSessionIdentity): boolean;
    proactivelyRotateForFamily(family: ModelFamily, model: string | null | undefined, headerStyle: HeaderStyle, softQuotaThresholdPercent: number, softQuotaCacheTtlMs: number, identity?: AccountSessionIdentity): ManagedAccount | null;
    markRateLimitedWithReason(account: ManagedAccount, family: ModelFamily, headerStyle: HeaderStyle, model: string | null | undefined, reason: RateLimitReason, retryAfterMs?: number | null, failureTtlMs?: number): number;
    markRequestSuccess(account: ManagedAccount): void;
    clearAllRateLimitsForFamily(family: ModelFamily, model?: string | null): void;
    shouldTryOptimisticReset(family: ModelFamily, model?: string | null): boolean;
    markAccountCoolingDown(account: ManagedAccount, cooldownMs: number, reason: CooldownReason): void;
    isAccountCoolingDown(account: ManagedAccount): boolean;
    clearAccountCooldown(account: ManagedAccount): void;
    getAccountCooldownReason(account: ManagedAccount): CooldownReason | undefined;
    markTouchedForQuota(account: ManagedAccount, quotaKey: string): void;
    isFreshForQuota(account: ManagedAccount, quotaKey: string): boolean;
    getFreshAccountsForQuota(quotaKey: string, family: ModelFamily, model?: string | null): ManagedAccount[];
    isRateLimitedForHeaderStyle(account: ManagedAccount, family: ModelFamily, headerStyle: HeaderStyle, model?: string | null): boolean;
    getAvailableHeaderStyle(account: ManagedAccount, family: ModelFamily, model?: string | null): HeaderStyle | null;
    /**
     * Check if any OTHER account has antigravity quota available for the given family/model.
     *
     * Used to determine whether to switch accounts vs fall back to gemini-cli:
     * - If true: Switch to another account (preserve antigravity priority)
     * - If false: All accounts exhausted antigravity, safe to fall back to gemini-cli
     *
     * @param currentAccountIndex - Index of the current account (will be excluded from check)
     * @param family - Model family ("gemini" or "claude")
     * @param model - Optional model name for model-specific rate limits
     * @returns true if any other enabled, non-cooling-down account has antigravity available
     */
    hasOtherAccountWithAntigravityAvailable(currentAccountIndex: number, family: ModelFamily, model?: string | null): boolean;
    setAccountEnabled(accountIndex: number, enabled: boolean): boolean;
    markAccountVerificationRequired(accountIndex: number, reason?: string, verifyUrl?: string): boolean;
    markAccountIneligible(accountIndex: number, reason?: string): boolean;
    clearAccountAccessBlocks(accountIndex: number, enableAccount?: boolean): boolean;
    removeAccountByIndex(accountIndex: number): boolean;
    removeAccount(account: ManagedAccount): boolean;
    updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void;
    toAuthDetails(account: ManagedAccount): OAuthAuthDetails;
    getMinWaitTimeForFamily(family: ModelFamily, model?: string | null, headerStyle?: HeaderStyle, strict?: boolean): number;
    getAccounts(): ManagedAccount[];
    private buildStorageSnapshot;
    saveToDisk(): Promise<void>;
    /**
     * Persist via full-file replace (no merge). Required after destructive
     * operations (account removal) so a deleted account is not resurrected by
     * mergeAccountStorage re-reading it from disk.
     */
    saveToDiskReplace(): Promise<void>;
    requestSaveToDisk(): void;
    flushSaveToDisk(): Promise<void>;
    dispose(): Promise<void>;
    private executeSave;
    /**
     * Regenerate fingerprint for an account, saving the old one to history.
     * @param accountIndex - Index of the account to regenerate fingerprint for
     * @returns The new fingerprint, or null if account not found
     */
    regenerateAccountFingerprint(accountIndex: number): Fingerprint | null;
    /**
     * Restore a fingerprint from history for an account.
     * @param accountIndex - Index of the account
     * @param historyIndex - Index in the fingerprint history to restore from (0 = most recent)
     * @returns The restored fingerprint, or null if account/history not found
     */
    restoreAccountFingerprint(accountIndex: number, historyIndex: number): Fingerprint | null;
    /**
     * Get fingerprint history for an account.
     * @param accountIndex - Index of the account
     * @returns Array of fingerprint versions, or empty array if not found
     */
    getAccountFingerprintHistory(accountIndex: number): FingerprintVersion[];
    updateQuotaCache(accountIndex: number, quotaGroups: Partial<Record<QuotaGroup, QuotaGroupSummary>>, expectedRefreshToken?: string): void;
    /**
     * Apply a subset of fields from a quota-fetch `updatedAccount` result onto
     * the live in-memory record for the given index. Only patches fields that
     * are present and non-empty in `patch` to avoid overwriting valid state
     * with stale or missing values.
     *
     * Identity guard: if `expectedRefreshToken` is provided and the account at
     * `accountIndex` no longer carries that token (concurrent reorder/replace),
     * the patch is silently dropped.
     *
     * `managedProjectId` is intentionally absent from the patch type: the only
     * caller (`BackgroundQuotaRefresh`) routes through `PollerAccountView` which
     * exposes only `capturedTierId`/`capturedTierAt`; project-context updates
     * happen via `ensureProjectContext`, not through this method.
     */
    applyUpdatedAccount(accountIndex: number, patch: Partial<Pick<AccountMetadataV3, 'capturedTierId' | 'capturedPaidTierId' | 'capturedTierAt' | 'capturedTierSchemaVersion'>>, expectedRefreshToken?: string): void;
    /**
     * Record a successful API request for an account.
     * Tracks per model family with daily reset.
     */
    recordRequest(accountIndex: number, family: ModelFamily): void;
    /**
     * Get request counts for an account for today.
     */
    getDailyRequestCounts(accountIndex: number): {
        date: string;
        claude: number;
        gemini: number;
    } | null;
    /**
     * Get total daily request counts across all accounts for a model family.
     */
    getTotalDailyRequests(family: ModelFamily): number;
    /**
     * Get a summary of daily request distribution across accounts.
     * Returns accounts sorted by request count (descending).
     */
    getDailyRequestSummary(family: ModelFamily): Array<{
        index: number;
        email?: string;
        count: number;
    }>;
    /**
     * Record a request for the current session (in-memory only).
     */
    recordSessionRequest(accountIndex: number, family: ModelFamily): void;
    /**
     * Get a summary of the current session's request usage.
     */
    getSessionSummary(): {
        durationMinutes: number;
        totalClaude: number;
        totalGemini: number;
        requestsPerHour: number;
        accountsUsed: number;
        perAccount: Array<{
            index: number;
            email?: string;
            claude: number;
            gemini: number;
        }>;
    };
    isAccountOverSoftQuota(account: ManagedAccount, family: ModelFamily, thresholdPercent: number, cacheTtlMs: number, model?: string | null): boolean;
    getAccountsForQuotaCheck(): AccountMetadataV3[];
    getOldestQuotaCacheAge(): number | null;
    areAllAccountsOverSoftQuota(family: ModelFamily, thresholdPercent: number, cacheTtlMs: number, model?: string | null): boolean;
    /**
     * Get minimum wait time until any account's soft quota resets.
     * Returns 0 if any account is available (not over threshold).
     * Returns the minimum resetTime across all over-threshold accounts.
     * Returns null if no resetTime data is available.
     */
    getMinWaitTimeForSoftQuota(family: ModelFamily, thresholdPercent: number, cacheTtlMs: number, model?: string | null): number | null;
}
//# sourceMappingURL=account-manager.d.ts.map