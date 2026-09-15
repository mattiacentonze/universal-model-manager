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
import { aggregateGeminiCliQuota, aggregateQuota, aggregateQuotaSummary, createQuotaManager, defaultKeyOf, fetchAvailableModels, fetchGeminiCliQuota, fetchQuotaSummary, getHealthTracker, } from '@cortexkit/antigravity-auth-core';
import { ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_PROVIDER_ID, buildGeminiCliUserAgent, } from '../constants';
import { buildSidebarMachineStateFromAccounts, isAccountCurrent, setSidebarMachineState, } from '../sidebar-state';
import { accessTokenExpired, formatRefreshParts, parseRefreshParts, } from './auth';
import { logQuotaFetch, logQuotaStatus } from './debug';
import { buildAntigravityHarnessUserAgent } from './fingerprint';
import { createLogger } from './logger';
import { ensureProjectContext, loadManagedProject } from './project';
import { refreshAccessToken } from './token';
// Re-export the public surface so existing imports from `./quota` keep working.
const log = createLogger('quota');
export { classifyQuotaGroup, createQuotaManager, defaultKeyOf, } from '@cortexkit/antigravity-auth-core';
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
export function createOpenCodeQuotaManager(client, providerId = ANTIGRAVITY_PROVIDER_ID, options = {}) {
    const fetchAccountQuota = makeFetchAccountQuota(client, providerId, options.fetchVia);
    const manager = createQuotaManager({
        fetchAccountQuota,
        keyOf: options.keyOf ?? defaultKeyOf,
        baseBackoffMs: options.baseBackoffMs,
        maxBackoffMs: options.maxBackoffMs,
        fetchTimeoutMs: options.fetchTimeoutMs,
    });
    const originalRefreshAccount = manager.refreshAccount;
    const originalRefreshAccounts = manager.refreshAccounts;
    const getAccountsForSidebar = options.getAccountsForSidebar;
    const getActiveIndexByFamily = options.getActiveIndexByFamily;
    let disposed = false;
    const inFlight = new Set();
    const pushAfterRefresh = async (account) => {
        if (!getAccountsForSidebar)
            return;
        await pushSidebarQuotaSnapshot(getAccountsForSidebar, manager.getBackoffUntil(account), getActiveIndexByFamily).catch(() => {
            // Sidebar persistence remains best-effort when lock contention
            // outlives its retry budget.
        });
    };
    const track = (operation) => {
        inFlight.add(operation);
        void operation.then(() => inFlight.delete(operation), () => inFlight.delete(operation));
        return operation;
    };
    const dispose = async () => {
        if (disposed)
            return;
        disposed = true;
        await manager.dispose();
        await Promise.allSettled(inFlight);
    };
    return {
        ...manager,
        async refreshAccount(account, refreshOptions) {
            const shouldPush = !disposed;
            return track((async () => {
                const result = await originalRefreshAccount(account, refreshOptions);
                if (shouldPush)
                    await pushAfterRefresh(account);
                return result;
            })());
        },
        async refreshAccounts(accounts, refreshOptions) {
            const shouldPush = !disposed;
            return track((async () => {
                const results = await originalRefreshAccounts(accounts, refreshOptions);
                // Push one snapshot per batch — the AccountManager's view is updated
                // by the caller (oauth-methods / fetch-interceptor) BEFORE we read
                // here, so a single post-batch snapshot captures the full diff.
                const lastAccount = accounts[accounts.length - 1];
                if (shouldPush && lastAccount)
                    await pushAfterRefresh(lastAccount);
                return results;
            })());
        },
        dispose,
    };
}
/**
 * Compatibility wrapper used by code paths that want a one-shot check across
 * the full account pool with no shared cache.
 *
 * Equivalent to spinning up a short-lived manager with `force: true` so
 * manual quota dialogs always reflect the latest data even if the background
 * manager has backed off.
 */
export async function checkAccountsQuotaWith(accounts, fetchAccountQuota) {
    const manager = createQuotaManager({
        fetchAccountQuota,
        keyOf: defaultKeyOf,
    });
    try {
        return await manager.refreshAccounts(accounts, {
            indexFor: (account) => accounts.indexOf(account),
            force: true,
        });
    }
    finally {
        manager.dispose();
    }
}
export async function checkAccountsQuotaStandalone(accounts, options) {
    if (!options.refresh) {
        return accounts.map((account, index) => ({
            index,
            email: account.email,
            status: account.enabled === false ? 'disabled' : 'ok',
            disabled: account.enabled === false,
            quota: {
                groups: account.cachedQuota ?? {},
                modelCount: Object.keys(account.cachedQuota ?? {}).length,
            },
        }));
    }
    return checkAccountsQuotaWith(accounts, makeFetchAccountQuota(undefined, ANTIGRAVITY_PROVIDER_ID));
}
export async function checkAccountsQuota(accounts, client, providerId = ANTIGRAVITY_PROVIDER_ID) {
    return checkAccountsQuotaWith(accounts, makeFetchAccountQuota(client, providerId));
}
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
export async function pushSidebarQuotaSnapshot(getAccounts, backoffUntil = 0, getActiveIndexByFamily) {
    const accounts = getAccounts();
    if (!accounts || accounts.length === 0)
        return;
    const activeByFamily = getActiveIndexByFamily?.() ?? null;
    try {
        await setSidebarMachineState(buildSidebarMachineStateFromAccounts(accounts.map((entry) => ({
            index: entry.index,
            label: entry.label,
            enabled: entry.enabled,
            current: activeByFamily
                ? isAccountCurrent(entry.index, activeByFamily)
                : false,
            coolingDownUntil: entry.coolingDownUntil,
            cachedQuota: entry.cachedQuota,
            cachedQuotaAccountId: entry.cachedQuotaAccountId,
            currentQuotaAccountId: entry.currentQuotaAccountId,
            healthScore: getHealthTracker().getScore(entry.index),
            tier: entry.tier,
        })), {
            checkedAt: Date.now(),
            quotaBackoffUntil: backoffUntil > 0 ? backoffUntil : undefined,
        }));
    }
    catch (error) {
        log.debug('sidebar-quota-write-failed', { error: String(error) });
    }
}
/**
 * Legacy fallback: fetchAvailableModels → aggregateQuota. Used when
 * `fetchQuotaSummary` rejects (network, 403, etc.). Extracted so the
 * concurrent fetch path can reuse the same fallback logic without
 * duplicating the catch chain.
 */
async function fetchLegacyModelsFallback(options) {
    try {
        const modelsResponse = await fetchAvailableModels({
            accessToken: options.accessToken,
            projectId: options.projectId,
            endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
            userAgent: buildAntigravityHarnessUserAgent(),
            timeoutMs: 10_000,
            ...(options.fetchVia ? { fetchVia: options.fetchVia } : {}),
        });
        if (modelsResponse.models) {
            return aggregateQuota(modelsResponse.models);
        }
        return {
            groups: {},
            modelCount: 0,
            error: 'Failed to fetch Antigravity quota (legacy fallback)',
        };
    }
    catch {
        return {
            groups: {},
            modelCount: 0,
            error: 'Failed to fetch Antigravity quota',
        };
    }
}
function makeFetchAccountQuota(client, providerId, fetchVia) {
    return async (account, signal) => {
        const index = 0;
        const disabled = account.enabled === false;
        if (disabled) {
            return {
                index,
                email: account.email,
                status: 'disabled',
                disabled: true,
            };
        }
        if (signal.aborted) {
            return {
                index,
                email: account.email,
                status: 'error',
                error: signal.reason instanceof Error ? signal.reason.message : 'aborted',
            };
        }
        let auth = buildAuthFromAccount(account);
        let rotatedRefresh;
        try {
            if (accessTokenExpired(auth)) {
                const refreshed = await refreshAccessToken(auth, client, providerId);
                if (!refreshed) {
                    throw new Error('Token refresh failed');
                }
                if (refreshed.refresh !== auth.refresh) {
                    rotatedRefresh = refreshed.refresh;
                }
                auth = refreshed;
            }
            const projectContext = await ensureProjectContext(auth);
            auth = projectContext.auth;
            const updatedAccount = applyAccountUpdates(account, auth, projectContext.capturedTier);
            if (rotatedRefresh && client) {
                await persistRotatedRefresh(client, providerId, auth).catch(() => { });
            }
            let quotaResult;
            let fellBackToLegacy = false;
            const authParts = parseRefreshParts(auth.refresh);
            // Bare refresh tokens have no packed project IDs — fall back to the
            // account record. The real managedProjectId lives on the persisted
            // account, not in the packed refresh string.
            const managedProjectId = authParts.managedProjectId ?? account.managedProjectId;
            // Two independent payload contracts: the windowed summary
            // (with legacy fallback) and the gemini-CLI quota. They share
            // access + project but target different endpoints, so the
            // two 10s timeouts ran back-to-back for ~20s per account on
            // modal open. Run them concurrently; either rejection is
            // handled by its own branch and the result is still merged.
            const fetchSummaryPayload = (async () => {
                try {
                    const summaryResult = await fetchQuotaSummary({
                        accessToken: auth.access ?? '',
                        managedProjectId,
                        projectId: projectContext.effectiveProjectId,
                        endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
                        userAgent: buildAntigravityHarnessUserAgent(),
                        timeoutMs: 10_000,
                        ...(fetchVia ? { fetchVia } : {}),
                    });
                    return {
                        result: aggregateQuotaSummary(summaryResult.summary),
                        fellBackToLegacy: summaryResult.fellBackToLegacy ?? false,
                    };
                }
                catch {
                    return {
                        result: await fetchLegacyModelsFallback({
                            accessToken: auth.access ?? '',
                            projectId: projectContext.effectiveProjectId,
                            fetchVia,
                        }),
                        fellBackToLegacy: true,
                    };
                }
            })();
            // CLI fetch is independent of the summary fetch. A CLI failure must
            // NOT kill the summary result, but it also must not be laundered into
            // "No Gemini CLI quota available" (a permanent-looking status) when
            // the real cause is a transient network error. Capture the error
            // message separately so the annotated result can carry it.
            let geminiCliFetchError;
            const fetchGeminiCliPayload = fetchGeminiCliQuota({
                accessToken: auth.access ?? '',
                projectId: projectContext.effectiveProjectId,
                endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
                userAgent: buildGeminiCliUserAgent(),
                timeoutMs: 10_000,
                ...(fetchVia ? { fetchVia } : {}),
            }).catch((error) => {
                geminiCliFetchError =
                    error instanceof Error ? error.message : String(error);
                log.debug('fetchGeminiCliQuota failed', { error: geminiCliFetchError });
                return { buckets: undefined };
            });
            const [summary, geminiCliResponse] = await Promise.all([
                fetchSummaryPayload,
                fetchGeminiCliPayload,
            ]);
            quotaResult = summary.result;
            fellBackToLegacy = summary.fellBackToLegacy;
            const geminiCliQuotaResult = aggregateGeminiCliQuota(geminiCliResponse);
            const annotated = geminiCliResponse.buckets === undefined ||
                geminiCliResponse.buckets.length === 0
                ? {
                    ...geminiCliQuotaResult,
                    error: 
                    // A real fetch exception is a transient failure, not a
                    // "no CLI configured" scenario — propagate the actual message.
                    geminiCliFetchError ??
                        (geminiCliQuotaResult.models.length === 0
                            ? 'No Gemini CLI quota available'
                            : undefined),
                }
                : geminiCliQuotaResult;
            for (const [family, groupQuota] of Object.entries(quotaResult.groups)) {
                const remainingPercent = (groupQuota.remainingFraction ?? 0) * 100;
                logQuotaStatus(account.email, index, remainingPercent, family);
            }
            const legacyTag = fellBackToLegacy ? ' legacy=1' : '';
            logQuotaFetch('complete', 1, `ok=1 errors=0${legacyTag}`);
            return {
                index,
                email: account.email,
                status: 'ok',
                disabled: false,
                quota: quotaResult,
                geminiCliQuota: annotated,
                updatedAccount,
            };
        }
        catch (error) {
            logQuotaFetch('error', undefined, `account=${account.email ?? index} error=${error instanceof Error ? error.message : String(error)}`);
            return {
                index,
                email: account.email,
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
                disabled: false,
            };
        }
    };
}
function buildAuthFromAccount(account) {
    return {
        type: 'oauth',
        refresh: formatRefreshParts({
            refreshToken: account.refreshToken,
            projectId: account.projectId,
            managedProjectId: account.managedProjectId,
        }),
        access: undefined,
        expires: undefined,
    };
}
function applyAccountUpdates(account, auth, capturedTier) {
    const parts = parseRefreshParts(auth.refresh);
    if (!parts.refreshToken) {
        return undefined;
    }
    const updated = {
        ...account,
        refreshToken: parts.refreshToken,
        projectId: parts.projectId ?? account.projectId,
        managedProjectId: parts.managedProjectId ?? account.managedProjectId,
        // Persist the captured tier alongside the project-context write. Only
        // present when the loadCodeAssist payload returned a non-empty currentTier.id.
        ...(capturedTier
            ? {
                capturedTierId: capturedTier.id,
                ...(capturedTier.paidId !== undefined
                    ? { capturedPaidTierId: capturedTier.paidId }
                    : {}),
                capturedTierAt: capturedTier.capturedAt,
            }
            : {}),
    };
    const changed = updated.refreshToken !== account.refreshToken ||
        updated.projectId !== account.projectId ||
        updated.managedProjectId !== account.managedProjectId ||
        updated.capturedTierId !== account.capturedTierId ||
        updated.capturedPaidTierId !== account.capturedPaidTierId ||
        // capturedAt represents when the tier was LAST CONFIRMED, not when it
        // changed -- always update it on a successful observation so consumers
        // can gate staleness on that timestamp even when the id stays the same.
        (capturedTier !== undefined &&
            updated.capturedTierAt !== account.capturedTierAt);
    return changed ? updated : undefined;
}
async function persistRotatedRefresh(client, providerId, auth) {
    await client.auth.set({
        path: { id: providerId },
        body: {
            type: 'oauth',
            refresh: auth.refresh,
            access: auth.access ?? '',
            expires: auth.expires ?? 0,
        },
    });
}
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
export function makeTierLoader(client, providerId) {
    return async (account) => {
        try {
            let auth = buildAuthFromAccount(account);
            if (accessTokenExpired(auth)) {
                const refreshed = await refreshAccessToken(auth, client, providerId);
                if (!refreshed)
                    return null;
                auth = refreshed;
            }
            const accessToken = auth.access;
            if (!accessToken)
                return null;
            const payload = await loadManagedProject(accessToken);
            if (!payload?.currentTier?.id)
                return null;
            const paidTierId = typeof payload.paidTier === 'string'
                ? payload.paidTier
                : payload.paidTier?.id;
            return {
                id: payload.currentTier.id,
                ...(paidTierId ? { paidId: paidTierId } : {}),
                capturedAt: Date.now(),
            };
        }
        catch {
            return null;
        }
    };
}
//# sourceMappingURL=quota.js.map