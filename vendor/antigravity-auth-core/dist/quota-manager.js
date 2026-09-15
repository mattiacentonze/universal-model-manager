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
import { createHash } from 'node:crypto';
import { fetchWithActiveTimeout } from "./fetch-timeout.js";
import { buildAntigravityHarnessUserAgent } from "./fingerprint.js";
import { createLogger } from "./logger.js";
import { getQuotaGroupForModel } from "./model-registry.js";
const log = createLogger('quota-manager');
export const QUOTA_MANAGER_DEFAULT_BASE_BACKOFF_MS = 30_000;
export const QUOTA_MANAGER_DEFAULT_MAX_BACKOFF_MS = 10 * 60 * 1000;
export const QUOTA_MANAGER_DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Default keyOf — prefers email, falls back to refresh-token hash so the
 * same identity is keyed even when emails are missing.
 */
export function defaultKeyOf(account) {
    if (account.email)
        return `e:${account.email.toLowerCase()}`;
    const token = account.refreshToken || '';
    return `t:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}
export function createQuotaManager(options) {
    const now = options.now ?? (() => Date.now());
    const baseBackoffMs = options.baseBackoffMs ?? QUOTA_MANAGER_DEFAULT_BASE_BACKOFF_MS;
    const maxBackoffMs = options.maxBackoffMs ?? QUOTA_MANAGER_DEFAULT_MAX_BACKOFF_MS;
    const fetchTimeoutMs = options.fetchTimeoutMs ?? QUOTA_MANAGER_DEFAULT_TIMEOUT_MS;
    const state = new Map();
    let disposed = false;
    const keyOf = (account) => options.keyOf(account);
    const recordSuccess = (key) => {
        const entry = state.get(key);
        if (!entry)
            return;
        entry.consecutiveFailures = 0;
        entry.backoffUntil = 0;
    };
    const recordFailure = (key) => {
        const current = now();
        const entry = state.get(key) ?? {
            consecutiveFailures: 0,
            backoffUntil: 0,
        };
        const failures = entry.consecutiveFailures + 1;
        const backoffMs = Math.min(maxBackoffMs, baseBackoffMs * 2 ** (failures - 1));
        entry.consecutiveFailures = failures;
        entry.backoffUntil = current + backoffMs;
        state.set(key, entry);
        return { backoffMs, backoffUntil: entry.backoffUntil };
    };
    const cacheResult = (key, result) => {
        const entry = state.get(key) ?? {
            consecutiveFailures: 0,
            backoffUntil: 0,
        };
        entry.cached = result;
        state.set(key, entry);
    };
    const buildDisabledResult = (account, index) => ({
        index,
        email: account.email,
        status: 'disabled',
        disabled: true,
        quota: undefined,
        geminiCliQuota: undefined,
        updatedAccount: undefined,
    });
    const buildSkippedResult = (account, index, backoffUntil) => {
        const cached = state.get(keyOf(account))?.cached;
        if (cached) {
            return { ...cached, index };
        }
        return {
            index,
            email: account.email,
            status: 'error',
            error: `quota refresh skipped (backoff until ${new Date(backoffUntil).toISOString()})`,
        };
    };
    const refreshAccount = async (account, refreshOptions) => {
        if (disposed) {
            return {
                index: refreshOptions.index,
                email: account.email,
                status: 'error',
                error: 'quota manager disposed',
            };
        }
        const { index, force = false } = refreshOptions;
        const key = keyOf(account);
        if (account.enabled === false) {
            const result = buildDisabledResult(account, index);
            cacheResult(key, result);
            return result;
        }
        const current = now();
        const entry = state.get(key);
        if (!force && entry && entry.backoffUntil > current) {
            return buildSkippedResult(account, index, entry.backoffUntil);
        }
        const inflight = entry?.inflight;
        if (inflight) {
            // Reuse the cached result of the in-flight fetch, but preserve this
            // caller's requested index for attribution.
            const cached = await inflight;
            return { ...cached, index };
        }
        const controller = new AbortController();
        const stored = state.get(key) ?? {
            consecutiveFailures: 0,
            backoffUntil: 0,
        };
        stored.controller = controller;
        state.set(key, stored);
        const promise = (async () => {
            try {
                const signal = AbortSignal.timeout(fetchTimeoutMs);
                const composite = controller.signal.aborted
                    ? controller.signal
                    : AbortSignal.any([controller.signal, signal]);
                const result = await options.fetchAccountQuota(account, composite);
                if (controller.signal.aborted) {
                    throw new Error('quota manager disposed mid-fetch');
                }
                const attributed = { ...result, index };
                cacheResult(key, attributed);
                // Adapter contract: `fetchAccountQuota` resolves with an
                // attributed result. Failures should arrive as `{ status: 'error' }`
                // rather than throwing — treat them like thrown failures so backoff
                // actually protects the account from re-hammering. `disabled` and
                // `ok` both count as success (no fetch happened, or it succeeded).
                if (result.status === 'error') {
                    const { backoffMs } = recordFailure(key);
                    log.debug('quota-refresh-failed', {
                        key: hashKey(key),
                        backoffMs,
                        error: result.error ?? 'attributed error result',
                    });
                    return attributed;
                }
                recordSuccess(key);
                return attributed;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (disposed || controller.signal.aborted) {
                    const failureResult = {
                        index,
                        email: account.email,
                        status: 'error',
                        error: message,
                    };
                    cacheResult(key, failureResult);
                    return failureResult;
                }
                const { backoffMs } = recordFailure(key);
                log.debug('quota-refresh-failed', {
                    key: hashKey(key),
                    backoffMs,
                    error: message,
                });
                const failureResult = {
                    index,
                    email: account.email,
                    status: 'error',
                    error: message,
                };
                cacheResult(key, failureResult);
                return failureResult;
            }
            finally {
                const finished = state.get(key);
                if (finished) {
                    finished.inflight = undefined;
                    finished.controller = undefined;
                    state.set(key, finished);
                }
            }
        })();
        stored.inflight = promise;
        state.set(key, stored);
        return promise;
    };
    const refreshAccounts = async (accounts, refreshOptions) => {
        const results = [];
        for (const account of accounts) {
            const index = refreshOptions.indexFor(account);
            const result = await refreshAccount(account, {
                index,
                force: refreshOptions.force,
            });
            results.push(result);
        }
        return results;
    };
    const getCached = (account) => {
        const entry = state.get(keyOf(account));
        return entry?.cached;
    };
    const getBackoffUntil = (account) => {
        return state.get(keyOf(account))?.backoffUntil ?? 0;
    };
    const hashedLogLabel = (prefix, account) => {
        const identity = typeof account === 'string' ? account : keyOf(account);
        return `${prefix} ${hashKey(identity)}`;
    };
    const dispose = async () => {
        if (disposed)
            return;
        disposed = true;
        // Snapshot the in-flight refreshes before aborting — the refresh
        // `finally` clears `entry.inflight` as each promise settles, so we
        // must capture the promises first.
        const pending = Array.from(state.values(), (entry) => entry.inflight).filter((promise) => promise != null);
        // Abort so a genuinely-stuck fetch unwinds promptly (the refresh
        // catches the abort and resolves with an error result rather than
        // hanging dispose), then AWAIT the settled promises. Awaiting after
        // the abort still fences the producer: the opencode quota wrapper's
        // fire-and-forget sidebar write runs in the continuation after the
        // core refresh resolves, so by the time dispose() resolves that
        // write has already been enqueued onto the sidebar chain and the
        // subsequent lifecycle drain will flush it.
        for (const [, entry] of state) {
            entry.controller?.abort();
        }
        if (pending.length > 0) {
            // Each refresh swallows its own errors and resolves; awaiting is a
            // fence, never a rejection surface.
            await Promise.allSettled(pending);
        }
        for (const [, entry] of state) {
            entry.inflight = undefined;
        }
    };
    return {
        refreshAccount,
        refreshAccounts,
        getCached,
        getBackoffUntil,
        hashedLogLabel,
        dispose,
        classifyQuotaGroup,
        aggregateQuota,
        aggregateGeminiCliQuota,
    };
}
function hashKey(key) {
    return createHash('sha256').update(key).digest('hex').slice(0, 8);
}
// ============================================================================
// Pure helpers — also exported for adapter use.
// ============================================================================
/**
 * Classify a model into its quota group.
 */
export function classifyQuotaGroup(modelName, displayName) {
    const registryGroup = getQuotaGroupForModel(modelName);
    if (registryGroup) {
        return registryGroup;
    }
    const combined = `${modelName} ${displayName ?? ''}`.toLowerCase();
    // Check Claude / GPT-OSS substrings BEFORE the `gemini` substring so a
    // `gemini-claude-*` alias (Claude route exposed under a `gemini-`
    // namespace) attributes to the non-gemini pool rather than the gemini
    // pool. `tab_*` autocomplete IDs are already classified by
    // `getQuotaGroupForModel` above (the registry/prefix branches), so
    // this fallback only runs for genuinely-unrecognised model strings.
    if (combined.includes('claude') || combined.includes('gpt-oss')) {
        return 'non-gemini';
    }
    if (combined.includes('gemini')) {
        return 'gemini';
    }
    return null;
}
function normalizeRemainingFraction(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 0;
    }
    if (value < 0)
        return 0;
    if (value > 1)
        return 1;
    return value;
}
function parseResetTime(resetTime) {
    if (!resetTime)
        return null;
    const timestamp = Date.parse(resetTime);
    if (!Number.isFinite(timestamp)) {
        return null;
    }
    return timestamp;
}
/**
 * Aggregate per-model quota entries into group summaries + per-model list.
 *
 * Pure helper — exposed for harness adapters that want to reuse the same
 * aggregation logic without re-implementing it.
 */
export function aggregateQuota(models) {
    const groups = {};
    const perModel = [];
    if (!models) {
        return { groups, perModel, modelCount: 0 };
    }
    let totalCount = 0;
    for (const [modelName, entry] of Object.entries(models)) {
        const group = classifyQuotaGroup(modelName, entry.displayName ?? entry.modelName);
        const quotaInfo = entry.quotaInfo;
        const remainingFraction = quotaInfo
            ? normalizeRemainingFraction(quotaInfo.remainingFraction)
            : undefined;
        const resetTime = quotaInfo?.resetTime;
        const resetTimestamp = parseResetTime(resetTime);
        totalCount += 1;
        perModel.push({
            modelId: modelName,
            displayName: entry.displayName ?? entry.modelName,
            group,
            remainingFraction: remainingFraction ?? 0,
            resetTime,
        });
        if (!group) {
            continue;
        }
        const existing = groups[group];
        const nextCount = (existing?.modelCount ?? 0) + 1;
        const nextRemaining = remainingFraction === undefined
            ? existing?.remainingFraction
            : existing?.remainingFraction === undefined
                ? remainingFraction
                : Math.min(existing.remainingFraction, remainingFraction);
        let nextResetTime = existing?.resetTime;
        if (resetTimestamp !== null) {
            if (!existing?.resetTime) {
                nextResetTime = resetTime;
            }
            else {
                const existingTimestamp = parseResetTime(existing.resetTime);
                if (existingTimestamp === null || resetTimestamp < existingTimestamp) {
                    nextResetTime = resetTime;
                }
            }
        }
        groups[group] = {
            remainingFraction: nextRemaining,
            resetTime: nextResetTime,
            modelCount: nextCount,
        };
    }
    perModel.sort((a, b) => a.modelId.localeCompare(b.modelId));
    return { groups, perModel, modelCount: totalCount };
}
/**
 * Derive the most-constrained window from a set of window entries.
 * Returns the entry with the smallest `remainingFraction` — this is the
 * binding constraint for the pool. `resetTime` comes from the same window.
 * Returns `undefined` when there are no windows.
 */
function mostConstrainedWindow(windows) {
    if (windows.length === 0)
        return undefined;
    let best = windows[0];
    for (let i = 1; i < windows.length; i++) {
        if (windows[i].remainingFraction < best.remainingFraction) {
            best = windows[i];
        }
    }
    return {
        remainingFraction: best.remainingFraction,
        resetTime: best.resetTime,
    };
}
/**
 * Map a retrieveUserQuotaSummary bucketId prefix to our internal pool.
 *
 * bucketId prefixes:
 *   `gemini-*` → gemini
 *   `3p-*`     → non-gemini
 */
function poolForBucketId(bucketId) {
    if (bucketId.startsWith('gemini-'))
        return 'gemini';
    if (bucketId.startsWith('3p-'))
        return 'non-gemini';
    return null;
}
/**
 * Count models listed in a group's description. The description is
 * typically a comma-separated list of model names ("Claude Sonnet 4.6,
 * Gemini 3.1 Pro, Flash") often prefixed with a label like
 * "Models within this group:". Strip the prefix before splitting so
 * the label itself is not counted as a model. Returns 0 for shapes
 * that don't match a comma-separated list.
 */
function parseDescriptionModelCount(description) {
    const prefixMatch = description.match(/^[^:]+:\s*/);
    const payload = prefixMatch
        ? description.slice(prefixMatch[0].length)
        : description;
    if (!payload)
        return 0;
    const entries = payload
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    return entries.length;
}
/**
 * Map a quota window kind to its duration in milliseconds for
 * deterministic sort order. Unknown windows get MAX_SAFE_INTEGER so
 * they sort last without random reordering across runs.
 */
function windowDurationMs(window) {
    switch (window) {
        case '5h':
            return 5 * 60 * 60 * 1000;
        case 'weekly':
            return 7 * 24 * 60 * 60 * 1000;
        default:
            return Number.MAX_SAFE_INTEGER;
    }
}
/**
 * Aggregate a retrieveUserQuotaSummary response into a QuotaSummary.
 *
 * Each RUQS group maps to a pool via bucketId prefix. Within a pool,
 * windows are stored shortest-first (5h before weekly, etc.). The pool's
 * `remainingFraction`/`resetTime` derive from the most-constrained window.
 */
export function aggregateQuotaSummary(response) {
    const groups = {};
    let totalCount = 0;
    for (const group of response.groups) {
        const windows = [];
        for (const bucket of group.buckets) {
            const pool = poolForBucketId(bucket.bucketId);
            if (!pool)
                continue;
            windows.push({
                window: bucket.window,
                remainingFraction: normalizeRemainingFraction(bucket.remainingFraction),
                resetTime: bucket.resetTime,
            });
        }
        if (windows.length === 0)
            continue;
        // Order: shortest window first so the binding 5h window leads visually.
        windows.sort((a, b) => windowDurationMs(a.window) - windowDurationMs(b.window));
        const constrained = mostConstrainedWindow(windows);
        // Pick the first RECOGNIZED bucket for pool derivation. Older
        // servers may prepend a junk bucket (system noise, a non-standard
        // prefix like `claude-3p-`) whose bucketId doesn't match any of
        // our pool prefixes; the legacy poolForBucketId derivation used
        // group.buckets[0] unconditionally, which silently dropped the
        // whole group when an unknown prefix led the array.
        const recognizedBucket = group.buckets.find((bucket) => poolForBucketId(bucket.bucketId));
        if (!recognizedBucket)
            continue;
        const pool = poolForBucketId(recognizedBucket.bucketId);
        if (!pool || !constrained)
            continue;
        // The description is a list of model names comma-separated, often
        // prefixed with a label like "Models within this group:". Strip
        // the prefix before splitting so it doesn't count as a model.
        const modelCount = group.description
            ? parseDescriptionModelCount(group.description)
            : 0;
        groups[pool] = {
            remainingFraction: constrained.remainingFraction,
            resetTime: constrained.resetTime,
            modelCount,
            windows,
        };
        totalCount += modelCount;
    }
    return { groups, modelCount: totalCount };
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
export async function fetchQuotaSummary(options) {
    const timeoutMs = options.timeoutMs ?? QUOTA_MANAGER_DEFAULT_TIMEOUT_MS;
    const userAgent = options.userAgent ?? buildAntigravityHarnessUserAgent();
    const transport = options.fetchVia ?? defaultTransport;
    const errors = [];
    if (options.endpoints.length === 0) {
        throw new Error('No endpoints configured for fetchQuotaSummary');
    }
    const tryBody = async (endpoint, projectId) => {
        const body = { project: projectId };
        try {
            const response = await transport(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
                method: 'POST',
                headers: {
                    'User-Agent': userAgent,
                    Authorization: `Bearer ${options.accessToken}`,
                    'Content-Type': 'application/json',
                    'Accept-Encoding': 'gzip',
                },
                body: JSON.stringify(body),
            }, { timeoutMs });
            if (response.ok) {
                return {
                    ok: true,
                    summary: (await response.json()),
                };
            }
            const status = response.status;
            if (status === 403) {
                errors.push(`retrieveUserQuotaSummary 403 at ${endpoint} (project=${projectId.slice(0, 12)}…)`);
                return { ok: false, reason: '403' };
            }
            if (status === 429 || status >= 500) {
                const message = await response.text().catch(() => '');
                errors.push(`retrieveUserQuotaSummary ${status} at ${endpoint}${message ? `: ${message.trim().slice(0, 200)}` : ''}`);
                // Endpoint failover: the caller may have multiple endpoints;
                // continue to the next one with the same project ID.
                return { ok: false, reason: 'transient' };
            }
            const message = await response.text().catch(() => '');
            errors.push(`retrieveUserQuotaSummary ${status} at ${endpoint}${message ? `: ${message.trim().slice(0, 200)}` : ''}`);
            return { ok: false, reason: 'transient' };
        }
        catch (error) {
            errors.push(`retrieveUserQuotaSummary network error at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
            return { ok: false, reason: 'transient' };
        }
    };
    // Try managedProjectId first, then projectId, then legacy fallback.
    // For each project, iterate the endpoint list so a 500/429 on the
    // primary endpoint falls through to the next entry.
    const primary = options.managedProjectId ?? options.projectId;
    let primaryGot403 = false;
    if (primary) {
        for (const endpoint of options.endpoints) {
            const result = await tryBody(endpoint, primary);
            if (result.ok)
                return { summary: result.summary };
            if (result.reason === '403')
                primaryGot403 = true;
        }
    }
    // Retry with the regular projectId ONLY when the managed-project attempt
    // got a 403 (i.e. the managed project does not own the user). A transient
    // failure (429, 5xx, network) must NOT fall through here — the regular
    // projectId could return a different project's quota data.
    const fallbackId = primaryGot403 &&
        options.managedProjectId &&
        options.projectId &&
        options.managedProjectId !== options.projectId
        ? options.projectId
        : undefined;
    if (fallbackId) {
        for (const endpoint of options.endpoints) {
            const result = await tryBody(endpoint, fallbackId);
            if (result.ok)
                return { summary: result.summary };
        }
    }
    // Give up — the caller should fall back to fetchAvailableModels.
    throw new Error(errors.join('; ') || 'fetchQuotaSummary failed: no project ID available');
}
/**
 * Aggregate Gemini CLI quota buckets into a summary.
 */
export function aggregateGeminiCliQuota(response) {
    const models = [];
    if (!response.buckets || response.buckets.length === 0) {
        return { models };
    }
    for (const bucket of response.buckets) {
        if (!bucket.modelId) {
            continue;
        }
        const modelId = bucket.modelId;
        const isRelevantModel = modelId.startsWith('gemini-3-') ||
            modelId.startsWith('gemini-3.') ||
            modelId.startsWith('gemini-2.5-');
        if (!isRelevantModel) {
            continue;
        }
        models.push({
            modelId: bucket.modelId,
            remainingFraction: normalizeRemainingFraction(bucket.remainingFraction),
            resetTime: bucket.resetTime,
        });
    }
    models.sort((a, b) => a.modelId.localeCompare(b.modelId));
    return { models };
}
export async function fetchAvailableModels(options) {
    const timeoutMs = options.timeoutMs ?? QUOTA_MANAGER_DEFAULT_TIMEOUT_MS;
    const userAgent = options.userAgent ?? buildAntigravityHarnessUserAgent();
    const errors = [];
    const transport = options.fetchVia ?? defaultTransport;
    for (const endpoint of options.endpoints) {
        const body = options.projectId ? { project: options.projectId } : {};
        try {
            const response = await transport(`${endpoint}/v1internal:fetchAvailableModels`, {
                method: 'POST',
                headers: {
                    'User-Agent': userAgent,
                    Authorization: `Bearer ${options.accessToken}`,
                    'Content-Type': 'application/json',
                    'Accept-Encoding': 'gzip',
                },
                body: JSON.stringify(body),
            }, { timeoutMs });
            if (response.ok) {
                return (await response.json());
            }
            const status = response.status;
            if (status === 403 && options.projectId) {
                try {
                    const retryResponse = await transport(`${endpoint}/v1internal:fetchAvailableModels`, {
                        method: 'POST',
                        headers: {
                            'User-Agent': userAgent,
                            Authorization: `Bearer ${options.accessToken}`,
                            'Content-Type': 'application/json',
                            'Accept-Encoding': 'gzip',
                        },
                        body: JSON.stringify({}),
                    }, { timeoutMs });
                    if (retryResponse.ok) {
                        return (await retryResponse.json());
                    }
                }
                catch {
                    // Fall through to next endpoint
                }
            }
            if (status === 429 || status >= 500) {
                const message = await response.text().catch(() => '');
                const snippet = message.trim().slice(0, 200);
                errors.push(`fetchAvailableModels ${status} at ${endpoint}${snippet ? `: ${snippet}` : ''}`);
                continue;
            }
            const message = await response.text().catch(() => '');
            const snippet = message.trim().slice(0, 200);
            errors.push(`fetchAvailableModels ${status} at ${endpoint}${snippet ? `: ${snippet}` : ''}`);
            break;
        }
        catch (error) {
            errors.push(`fetchAvailableModels network error at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new Error(errors.join('; ') || 'fetchAvailableModels failed');
}
export async function fetchGeminiCliQuota(options) {
    const timeoutMs = options.timeoutMs ?? QUOTA_MANAGER_DEFAULT_TIMEOUT_MS;
    const userAgent = options.userAgent ?? buildAntigravityHarnessUserAgent();
    const transport = options.fetchVia ?? defaultTransport;
    const errors = [];
    for (const endpoint of options.endpoints) {
        const body = options.projectId ? { project: options.projectId } : {};
        try {
            const response = await transport(`${endpoint}/v1internal:retrieveUserQuota`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${options.accessToken}`,
                    'Content-Type': 'application/json',
                    'User-Agent': userAgent,
                },
                body: JSON.stringify(body),
            }, { timeoutMs });
            if (response.ok) {
                return (await response.json());
            }
            const status = response.status;
            if (status === 429 || status >= 500) {
                errors.push(`fetchGeminiCliQuota ${status} at ${endpoint}`);
                continue;
            }
            // Non-retryable server response (e.g. 403) — treat as no CLI quota.
            return { buckets: [] };
        }
        catch (error) {
            // Transport-level failure (network abort, DNS, timeout). Collect the
            // error and try the next endpoint; if all endpoints fail, throw so
            // the caller can distinguish a transient network failure from an
            // authoritative 'no CLI quota configured' response.
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }
    // All endpoints produced transport-level errors — propagate so the
    // outer caller (quota.ts .catch) can surface the real failure reason
    // rather than the generic 'No Gemini CLI quota available' message.
    if (errors.length > 0) {
        throw new Error(errors.join('; ') || 'fetchGeminiCliQuota failed');
    }
    return { buckets: [] };
}
async function defaultTransport(url, init, options) {
    return fetchWithActiveTimeout(url, init, { timeoutMs: options.timeoutMs });
}
//# sourceMappingURL=quota-manager.js.map