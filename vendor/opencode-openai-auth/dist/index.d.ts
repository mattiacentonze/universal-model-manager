import type { Hooks, Plugin, PluginInput } from '@opencode-ai/plugin';
import { type ResetTargetIdentity } from './commands';
import { type AccountStorage, type FallbackAccount, loadAccounts, type OAuthAccount, type OAuthQuotaSnapshot } from './core/accounts';
import { QuotaManager } from './core/quota-manager';
import { type SidebarMachineState, type SidebarState } from './sidebar-state';
export declare const MAIN_REFRESH_LOCK_TTL_MS: number;
export declare const MAIN_REFRESH_LEASE_TTL_MS = 90000;
export declare class AuthPersistError extends Error {
    readonly code = "OPENAI_AUTH_PERSIST_FAILED";
    constructor(cause: unknown);
}
export type ResetTargetResolutionErrorKind = 'unknown_account' | 'disabled_account' | 'non_oauth_account' | 'token_unavailable';
export declare class ResetTargetResolutionError extends Error {
    readonly code: ResetTargetResolutionErrorKind;
    constructor(code: ResetTargetResolutionErrorKind, message: string);
}
interface ResetTargetResolverDeps {
    getAuth: () => Promise<{
        type: string;
        access?: string;
        refresh?: string;
        expires?: number;
    }>;
    refreshMainWithLease: () => Promise<{
        access: string;
        refresh: string;
        expires: number;
    }>;
    refreshFallbackAccount: (account: OAuthAccount, storage: AccountStorage) => Promise<OAuthAccount>;
    loadAccounts: typeof loadAccounts;
    accountStoragePath: string;
    now: () => number;
}
export declare function createResetTargetResolver(deps: ResetTargetResolverDeps): (accountKey: string) => Promise<ResetTargetIdentity>;
export declare function buildResetRedemptionDeps(): {
    fetchImpl: typeof fetch;
    now: () => number;
    randomUUID: () => `${string}-${string}-${string}-${string}-${string}`;
};
export { extractAccountIdFromClaims, type IdTokenClaims, parseJwtClaims, } from './core/oauth';
interface CodexAuthPluginOptions {
    issuer?: string;
    codexApiEndpoint?: string;
    experimentalWebSockets?: boolean;
    responsesLite?: boolean;
}
export declare function findCachekeepFallbackAccount(accounts: FallbackAccount[], accountId: string): OAuthAccount | undefined;
export declare function mergePushedQuotaMetadata(incoming: OAuthQuotaSnapshot, previous: OAuthQuotaSnapshot | undefined): OAuthQuotaSnapshot;
export declare function buildSidebarMachineState(qm: QuotaManager, store: AccountStorage, now?: number, mainAccountIdentity?: string | undefined): SidebarMachineState;
export declare function buildSidebarState(qm: QuotaManager, store: AccountStorage, activeId: string, now?: number): SidebarState;
export declare function resolveSidebarSessionId(headers: Headers): string | undefined;
export declare function CodexAuthPlugin(input: PluginInput, options?: CodexAuthPluginOptions): Promise<Hooks>;
export declare const OpenAIAuthPlugin: Plugin;
declare const _default: {
    id: string;
    server: Plugin;
};
export default _default;
