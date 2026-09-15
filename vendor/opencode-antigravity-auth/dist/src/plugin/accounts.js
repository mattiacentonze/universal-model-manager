import { AccountManager as CoreAccountManager, } from '@cortexkit/antigravity-auth-core';
import { debugLogToFile } from './debug';
import { getStoragePath, loadAccounts, saveAccounts, saveAccountsReplace, } from './storage';
export { calculateBackoffMs, computeSoftQuotaCacheTtlMs, parseRateLimitReason, resolveQuotaGroup, } from '@cortexkit/antigravity-auth-core';
const openCodeStore = {
    load: async () => loadAccounts(),
    saveMerged: async (_path, next) => {
        await saveAccounts(next);
        return next;
    },
    mutate: async (_path, fn) => {
        const current = (await loadAccounts()) ?? {
            version: 4,
            accounts: [],
            activeIndex: 0,
        };
        const next = (await fn(current)) ?? current;
        await saveAccountsReplace(next);
        return next;
    },
    clear: async () => { },
};
export class AccountManager extends CoreAccountManager {
    constructor(authFallback, stored, options = {}) {
        super(authFallback, stored, {
            store: options.store ?? openCodeStore,
            storagePath: options.storagePath ?? getStoragePath(),
            now: options.now,
            random: options.random,
            pid: options.pid ?? process.pid,
            onDiagnostic: options.onDiagnostic ??
                ((message, fields) => debugLogToFile(fields ? `${message} ${JSON.stringify(fields)}` : message)),
        });
    }
    static async loadFromDisk(authFallback) {
        return new AccountManager(authFallback, await loadAccounts());
    }
}
//# sourceMappingURL=accounts.js.map