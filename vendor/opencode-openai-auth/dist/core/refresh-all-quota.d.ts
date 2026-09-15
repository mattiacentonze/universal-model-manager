import { type SidebarState } from '../sidebar-state';
import type { FallbackAccountManager, isOAuthAccount, loadAccounts } from './accounts';
import type { whamUsageFn } from './provider';
import type { QuotaManager } from './quota-manager';
declare const log: {
    error: (m: string, d?: unknown) => void;
    warn: (m: string, d?: unknown) => void;
    info: (m: string, d?: unknown) => void;
    debug: (m: string, d?: unknown) => void;
    trace: (m: string, d?: unknown) => void;
};
type QuotaLogger = Pick<typeof log, 'debug' | 'warn'>;
export interface RefreshAllQuotaDeps {
    getAuth: () => Promise<{
        type: string;
        access?: string;
        refresh?: string;
        expires?: number;
    }>;
    codexRefreshFn: (input: {
        refreshToken: string;
        fetchImpl: typeof fetch;
        now: () => number;
    }) => Promise<{
        access: string;
        refresh: string;
        expires: number;
    }>;
    refreshMainWithLease: () => Promise<{
        access: string;
        refresh: string;
        expires: number;
    }>;
    fallbackManager: FallbackAccountManager;
    quotaManager: QuotaManager;
    loadAccounts: typeof loadAccounts;
    writeSidebarState: (qm: QuotaManager, store: Awaited<ReturnType<typeof loadAccounts>>) => Promise<void>;
    client: {
        auth: {
            set: (input: {
                path: {
                    id: string;
                };
                body: {
                    type: string;
                    access?: string;
                    refresh: string;
                    expires?: number;
                };
            }) => Promise<unknown>;
        };
    };
    fetchImpl: typeof fetch;
    now: () => number;
    configPath: string;
    storageMainAccountId: string | undefined;
    isOAuthAccountFn: typeof isOAuthAccount;
    whamFn?: typeof whamUsageFn;
    respectBackoff?: boolean;
    logger?: QuotaLogger;
    skipFresherThanMs?: number;
    readSidebarState?: () => Promise<SidebarState>;
}
export interface RefreshAllQuotaOptions {
    accountKey?: string;
}
export interface RefreshAllQuotaOptions {
    accountKey?: string;
}
export interface RefreshAllQuotaResult {
    account: string;
    ok: boolean;
    error?: string;
    /**
     * The account cannot recover on its own: the provider has rejected its
     * credentials, so no amount of retrying will help until the operator re-adds
     * it.
     *
     * Carried as a flag rather than left for the caller to infer from `error`,
     * because sniffing an error string for a user-facing decision breaks the
     * moment the wording changes.
     */
    permanent?: boolean;
}
export declare function refreshAllQuota(deps: RefreshAllQuotaDeps, options?: RefreshAllQuotaOptions): Promise<RefreshAllQuotaResult[]>;
export {};
