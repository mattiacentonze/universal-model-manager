import { type AccountManagerOptions, AccountManager as CoreAccountManager } from '@cortexkit/antigravity-auth-core';
import { loadAccounts } from './storage';
import type { OAuthAuthDetails } from './types';
export type { AccountModelFamily as ModelFamily, AccountSessionIdentity, CooldownReason, HeaderStyle, ManagedAccount, RateLimitReason, } from '@cortexkit/antigravity-auth-core';
export { calculateBackoffMs, computeSoftQuotaCacheTtlMs, parseRateLimitReason, resolveQuotaGroup, } from '@cortexkit/antigravity-auth-core';
export declare class AccountManager extends CoreAccountManager {
    constructor(authFallback?: OAuthAuthDetails, stored?: Awaited<ReturnType<typeof loadAccounts>>, options?: Partial<AccountManagerOptions>);
    static loadFromDisk(authFallback?: OAuthAuthDetails): Promise<AccountManager>;
}
//# sourceMappingURL=accounts.d.ts.map