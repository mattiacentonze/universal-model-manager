/**
 * OpenCode adapter for the harness-agnostic quota manager.
 *
 * Re-exports the core `QuotaManager` types and helpers so call sites in
 * `plugin.ts` and other modules don't need to switch imports. Also wires up
 * the host-specific fetch callback that handles:
 *   1. Token refresh via the existing `refreshAccessToken` path.
 *   2. Persisting rotated refresh tokens via `client.auth.set` (matching
 *      legacy behavior).
 *   3. Resolving project context via `ensureProjectContext`.
 *
 * The legacy `checkAccountsQuota(accounts, client, providerId)` export is
 * retained as a compatibility wrapper that creates a short-lived manager
 * with `force: true` — manual quota screens must always refresh, even if
 * the background manager has backed off.
 */
import { type AccountMetadataV3, type AccountQuotaResult, type FetchAccountQuota, type FetchAvailableModelsOptions, type QuotaManager } from '@cortexkit/antigravity-auth-core';
import type { PluginClient } from './types';
type QuotaFetch = NonNullable<FetchAvailableModelsOptions['fetchVia']>;
export type { AccountQuotaResult, AccountQuotaStatus, GeminiCliQuotaModel, GeminiCliQuotaSummary, PerModelQuotaEntry, QuotaGroup, QuotaGroupSummary, QuotaManager, QuotaManagerOptions, QuotaSummary, } from '@cortexkit/antigravity-auth-core';
export { classifyQuotaGroup, createQuotaManager, defaultKeyOf, } from '@cortexkit/antigravity-auth-core';
export interface CreateOpenCodeQuotaManagerOptions {
    /** Override the default key derivation (email → refresh-token hash). */
    keyOf?: (account: AccountMetadataV3) => string;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    fetchTimeoutMs?: number;
}
/**
 * Build an OpenCode-wired quota manager.
 *
 * The returned manager owns its cache, in-flight dedupe, and backoff state.
 * Register its `dispose()` with `PluginLifecycle` so refreshes abort on plugin
 * shutdown.
 *
 * The wrapper observes `refreshAccount` / `refreshAccounts` and pushes a
 * redacted sidebar snapshot after every refresh (success or backoff) so
 * the TUI's next poll renders the freshest cached quota. The snapshot is
 * sourced from the live AccountManager view (`getAccountsForSidebar`) so
 * it carries the just-updated percentages; before bootstrapping it is a
 * no-op.
 */
export declare function createOpenCodeQuotaManager(client: PluginClient, providerId?: string, options?: CreateOpenCodeQuotaManagerOptions & {
    /**
     * Optional account-snapshot provider. Wired by the plugin entry to
     * the live `AccountManager.getAccounts()` so each refresh can build
     * a sidebar snapshot from the actual cached quota + cooldown. When
     * omitted, the wrapper falls back to a no-op snapshot push.
     */
    getAccountsForSidebar?: () => Array<{
        index: number;
        label?: string;
        enabled?: boolean;
        coolingDownUntil?: number;
        cachedQuota?: AccountMetadataV3['cachedQuota'];
        cachedQuotaAccountId?: string;
        currentQuotaAccountId?: string;
    }> | null;
    /**
     * Optional provider for the active-account indexes per model family.
     * Wired by the plugin entry so every quota-refresh sidebar snapshot
     * carries the real `current` flag — not a hardcoded `false`.
     */
    getActiveIndexByFamily?: () => {
        claude: number;
        gemini: number;
    } | null;
    /**
     * Optional transport adapter used for both `fetchAvailableModels`
     * and the project-context lookup. When omitted, the production
     * `fetchWithAgyCliTransport` runs and binds to the real
     * Antigravity endpoints; the e2e harness injects a mock here so
     * quota refresh + project discovery stay on the loopback server.
     */
    fetchVia?: QuotaFetch;
}): QuotaManager;
/**
 * Compatibility wrapper used by code paths that want a one-shot check across
 * the full account pool with no shared cache.
 *
 * Equivalent to spinning up a short-lived manager with `force: true` so
 * manual quota dialogs always reflect the latest data even if the background
 * manager has backed off.
 */
export declare function checkAccountsQuotaWith(accounts: AccountMetadataV3[], fetchAccountQuota: FetchAccountQuota): Promise<AccountQuotaResult[]>;
export declare function checkAccountsQuotaStandalone(accounts: AccountMetadataV3[], options: {
    refresh: boolean;
}): Promise<AccountQuotaResult[]>;
export declare function checkAccountsQuota(accounts: AccountMetadataV3[], client: PluginClient, providerId?: string): Promise<AccountQuotaResult[]>;
/**
 * Push a quota refresh into the sidebar. Called by every quota refresh
 * call site (manual `/antigravity-quota`, the `check` menu action, and the
 * background refresh in `fetch-interceptor`) AFTER the results have been
 * folded back into the AccountManager's cached quota. The function reads
 * the live account snapshot through `getAccounts` so the redacted entry
 * carries the just-refreshed percentages — not the previous tick's stale
 * numbers and not `undefined`.
 *
 * The mapping is deliberately tolerant: if `getAccounts` returns `null`
 * (e.g. before the plugin has finished bootstrapping) the call is a no-op.
 * On lock contention the error is logged-and-swallowed so a quota dialog
 * never fails just because the sidebar file is busy.
 */
export declare function pushSidebarQuotaSnapshot(getAccounts: () => Array<{
    index: number;
    label?: string;
    enabled?: boolean;
    coolingDownUntil?: number;
    cachedQuota?: AccountMetadataV3['cachedQuota'];
    cachedQuotaAccountId?: string;
    currentQuotaAccountId?: string;
    /** Captured plan tier to surface in the sidebar state file. */
    tier?: {
        id: string;
        paidId?: string;
        capturedAt: number;
    };
}> | null, backoffUntil?: number, getActiveIndexByFamily?: () => {
    claude: number;
    gemini: number;
} | null): Promise<void>;
/**
 * Build a per-account tier-loader callback for the background poller.
 *
 * Calls `loadManagedProject` (loadCodeAssist) directly, bypassing the
 * `ensureProjectContext` cache that fast-paths on `managedProjectId` and
 * never returns a tier for existing accounts. One call per account per 24 h.
 *
 * Uses the same token-refresh infrastructure as `makeFetchAccountQuota` so
 * an expired access token does not silently fail the tier lookup.
 *
 * `loadManagedProject` uses the production TLS transport (`fetchWithAgyCliTransport`)
 * and is not interceptable via `fetchVia` -- the same design constraint applies to
 * `ensureProjectContext`. Tier lookup is best-effort; any failure resolves `null`.
 */
export declare function makeTierLoader(client: PluginClient | undefined, providerId: string): (account: AccountMetadataV3) => Promise<{
    id: string;
    paidId?: string;
    capturedAt: number;
} | null>;
//# sourceMappingURL=quota.d.ts.map