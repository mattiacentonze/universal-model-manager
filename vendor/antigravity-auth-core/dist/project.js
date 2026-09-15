import { fetchWithAgyCliTransport } from "./agy-transport.js";
import { formatRefreshParts, parseRefreshParts } from "./auth.js";
import { ANTIGRAVITY_DEFAULT_PROJECT_ID, ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_ENDPOINT_PROD, ANTIGRAVITY_LOAD_ENDPOINTS, } from "./constants.js";
import { buildAntigravityHarnessBootstrapHeaders, buildAntigravityLoadCodeAssistMetadata, } from "./fingerprint.js";
import { createLogger } from "./logger.js";
const log = createLogger('project');
/** TTL for project context cache entries (30 minutes). */
const PROJECT_CONTEXT_CACHE_TTL_MS = 30 * 60 * 1000;
const projectContextResultCache = new Map();
const projectContextPendingCache = new Map();
const provisionFailedKeys = new Set();
function buildBootstrapRequestBody(extra = {}) {
    return {
        ...extra,
        metadata: buildAntigravityLoadCodeAssistMetadata(),
    };
}
/**
 * Selects the default tier ID from the allowed tiers list.
 */
function getDefaultTierId(allowedTiers) {
    if (!allowedTiers || allowedTiers.length === 0) {
        return undefined;
    }
    for (const tier of allowedTiers) {
        if (tier?.isDefault) {
            return tier.id;
        }
    }
    return allowedTiers[0]?.id;
}
/**
 * Promise-based delay utility.
 */
function wait(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
/**
 * Extracts the cloudaicompanion project id from loadCodeAssist responses.
 */
function extractManagedProjectId(payload) {
    if (!payload) {
        return undefined;
    }
    if (typeof payload.cloudaicompanionProject === 'string') {
        return payload.cloudaicompanionProject;
    }
    if (payload.cloudaicompanionProject &&
        typeof payload.cloudaicompanionProject.id === 'string') {
        return payload.cloudaicompanionProject.id;
    }
    return undefined;
}
/**
 * Generates a stable cache key from the OAuth refresh token itself. Packed
 * project fields may change after discovery, but they still identify the same
 * credential and must hit the same project-context cache entry.
 */
function getCacheKeyFromRefresh(refresh) {
    const packedRefresh = refresh?.trim();
    if (!packedRefresh)
        return undefined;
    return parseRefreshParts(packedRefresh).refreshToken.trim() || packedRefresh;
}
function getCacheKey(auth) {
    return getCacheKeyFromRefresh(auth.refresh);
}
/**
 * Clears cached project context results and pending promises, globally or for a refresh key.
 */
export function invalidateProjectContextCache(refresh) {
    if (!refresh) {
        projectContextPendingCache.clear();
        projectContextResultCache.clear();
        provisionFailedKeys.clear();
        return;
    }
    const cacheKey = getCacheKeyFromRefresh(refresh);
    if (!cacheKey)
        return;
    projectContextPendingCache.delete(cacheKey);
    projectContextResultCache.delete(cacheKey);
    provisionFailedKeys.delete(cacheKey);
}
export function clearProvisionFailedKeys() {
    provisionFailedKeys.clear();
}
/**
 * Loads managed project information for the given access token and optional project.
 */
export async function loadManagedProject(accessToken, _projectId) {
    const requestBody = buildBootstrapRequestBody();
    const loadHeaders = buildAntigravityHarnessBootstrapHeaders(accessToken);
    const loadEndpoints = Array.from(new Set([
        ...ANTIGRAVITY_LOAD_ENDPOINTS,
        ...ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ]));
    for (const baseEndpoint of loadEndpoints) {
        try {
            const response = await fetchWithAgyCliTransport(`${baseEndpoint}/v1internal:loadCodeAssist`, {
                method: 'POST',
                headers: loadHeaders,
                body: JSON.stringify(requestBody),
            });
            if (!response.ok) {
                continue;
            }
            return (await response.json());
        }
        catch (error) {
            log.debug('Failed to load managed project', {
                endpoint: baseEndpoint,
                error: String(error),
            });
        }
    }
    return null;
}
/**
 * Onboards a managed project for the user, optionally retrying until completion.
 */
export async function onboardManagedProject(accessToken, tierId, projectId, attempts = 10, delayMs = 5000) {
    const requestBody = { tierId };
    const onboardEndpoints = Array.from(new Set([
        ANTIGRAVITY_ENDPOINT_PROD,
        ...ANTIGRAVITY_LOAD_ENDPOINTS,
        ...ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ]));
    for (const baseEndpoint of onboardEndpoints) {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                const response = await fetchWithAgyCliTransport(`${baseEndpoint}/v1internal:onboardUser`, {
                    method: 'POST',
                    headers: buildAntigravityHarnessBootstrapHeaders(accessToken),
                    body: JSON.stringify(requestBody),
                });
                if (!response.ok) {
                    log.debug('Onboard request failed', {
                        endpoint: baseEndpoint,
                        status: response.status,
                        statusText: response.statusText,
                    });
                    break;
                }
                const payload = (await response.json());
                const managedProjectId = payload.response?.cloudaicompanionProject?.id;
                if (payload.done && managedProjectId) {
                    return managedProjectId;
                }
                if (payload.done && projectId) {
                    return projectId;
                }
            }
            catch (error) {
                log.debug('Failed to onboard managed project', {
                    endpoint: baseEndpoint,
                    error: String(error),
                });
                break;
            }
            await wait(delayMs);
        }
    }
    return undefined;
}
/**
 * Resolves an effective project ID for the current auth state, caching results per refresh token.
 */
export async function ensureProjectContext(auth) {
    const accessToken = auth.access;
    if (!accessToken) {
        return { auth, effectiveProjectId: '' };
    }
    const cacheKey = getCacheKey(auth);
    if (cacheKey) {
        const cached = projectContextResultCache.get(cacheKey);
        if (cached && Date.now() - cached.cachedAt < PROJECT_CONTEXT_CACHE_TTL_MS) {
            return cached.result;
        }
        if (cached) {
            // Expired — evict stale entry
            projectContextResultCache.delete(cacheKey);
        }
        const pending = projectContextPendingCache.get(cacheKey);
        if (pending) {
            return pending;
        }
    }
    const resolveContext = async () => {
        const parts = parseRefreshParts(auth.refresh);
        if (parts.managedProjectId) {
            return { auth, effectiveProjectId: parts.managedProjectId };
        }
        const fallbackProjectId = ANTIGRAVITY_DEFAULT_PROJECT_ID;
        if (cacheKey && provisionFailedKeys.has(cacheKey)) {
            const effectiveProjectId = parts.projectId || fallbackProjectId;
            return { auth, effectiveProjectId };
        }
        const persistManagedProject = async (managedProjectId, capturedTier) => {
            const updatedAuth = {
                ...auth,
                refresh: formatRefreshParts({
                    refreshToken: parts.refreshToken,
                    projectId: parts.projectId,
                    managedProjectId,
                }),
            };
            return {
                auth: updatedAuth,
                effectiveProjectId: managedProjectId,
                capturedTier,
            };
        };
        // Try to resolve a managed project from Antigravity if possible.
        const loadPayload = await loadManagedProject(accessToken, parts.projectId ?? fallbackProjectId);
        // Capture tier from the loadCodeAssist payload. The raw id is stored
        // as-is; absent payload or missing tier leaves capturedTier undefined.
        const capturedTierId = loadPayload?.currentTier?.id;
        const paidTierId = typeof loadPayload?.paidTier === 'string'
            ? loadPayload.paidTier
            : loadPayload?.paidTier?.id;
        const tierFromPayload = capturedTierId
            ? {
                id: capturedTierId,
                ...(paidTierId ? { paidId: paidTierId } : {}),
                capturedAt: Date.now(),
            }
            : undefined;
        const resolvedManagedProjectId = extractManagedProjectId(loadPayload);
        if (resolvedManagedProjectId) {
            return persistManagedProject(resolvedManagedProjectId, tierFromPayload);
        }
        // No managed project found - try to auto-provision one via onboarding.
        // This handles accounts that were added before managed project provisioning was required.
        const tierId = getDefaultTierId(loadPayload?.allowedTiers) ?? 'free-tier';
        log.debug('Auto-provisioning managed project', {
            tierId,
            projectId: parts.projectId,
        });
        const provisionedProjectId = await onboardManagedProject(accessToken, tierId, parts.projectId);
        if (provisionedProjectId) {
            log.debug('Successfully provisioned managed project', {
                provisionedProjectId,
            });
            return persistManagedProject(provisionedProjectId, tierFromPayload);
        }
        log.warn('Failed to provision managed project - account may not work correctly', {
            hasProjectId: !!parts.projectId,
        });
        if (cacheKey) {
            provisionFailedKeys.add(cacheKey);
        }
        if (parts.projectId) {
            return {
                auth,
                effectiveProjectId: parts.projectId,
                capturedTier: tierFromPayload,
            };
        }
        // No project id present in auth; fall back to the hardcoded id for requests.
        return {
            auth,
            effectiveProjectId: fallbackProjectId,
            capturedTier: tierFromPayload,
        };
    };
    if (!cacheKey) {
        return resolveContext();
    }
    const promise = resolveContext()
        .then((result) => {
        const nextKey = getCacheKey(result.auth) ?? cacheKey;
        projectContextPendingCache.delete(cacheKey);
        projectContextResultCache.set(nextKey, { result, cachedAt: Date.now() });
        if (nextKey !== cacheKey) {
            projectContextResultCache.delete(cacheKey);
        }
        return result;
    })
        .catch((error) => {
        projectContextPendingCache.delete(cacheKey);
        throw error;
    });
    projectContextPendingCache.set(cacheKey, promise);
    return promise;
}
//# sourceMappingURL=project.js.map