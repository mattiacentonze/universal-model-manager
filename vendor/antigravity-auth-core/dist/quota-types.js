/**
 * Harness-agnostic quota types.
 *
 * Quota group / per-model / CLI summary shapes shared between the core
 * quota helpers and any harness that wants to display quota status. Kept
 * separate from `account-types.ts` so quota evolution does not force a
 * migration on the persisted account pool.
 */
/**
 * Migrate pre-pool quota keys while loading persisted account data. Current
 * keys pass through unchanged, making this safe for every storage read.
 */
export function normalizeLegacyCachedQuota(raw) {
    if (!raw)
        return raw;
    const hasLegacy = 'gemini-pro' in raw ||
        'gemini-flash' in raw ||
        'claude' in raw ||
        'gpt-oss' in raw;
    if (!hasLegacy)
        return raw;
    const earlierResetTime = (a, b) => {
        if (!a)
            return b;
        if (!b)
            return a;
        return a < b ? a : b;
    };
    const minFraction = (a, b) => {
        if (!a)
            return b;
        if (!b)
            return a;
        const fa = a.remainingFraction ?? 1;
        const fb = b.remainingFraction ?? 1;
        const winner = fa <= fb ? a : b;
        const loser = fa <= fb ? b : a;
        return {
            ...winner,
            resetTime: earlierResetTime(winner.resetTime, loser.resetTime),
        };
    };
    const gemini = minFraction(raw.gemini, minFraction(raw['gemini-pro'], raw['gemini-flash']));
    const nonGemini = minFraction(raw['non-gemini'], minFraction(raw.claude, raw['gpt-oss']));
    return {
        ...(gemini !== undefined ? { gemini } : {}),
        ...(nonGemini !== undefined ? { 'non-gemini': nonGemini } : {}),
    };
}
//# sourceMappingURL=quota-types.js.map