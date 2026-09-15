import { AccountManager } from './accounts';
import type { AntigravityConfig } from './config';
import { getLogFilePath, isDebugEnabled } from './debug';
import type { PluginLifecycle } from './lifecycle';
import { createProactiveRefreshQueue } from './refresh-queue';
import { clearAccounts, loadAccounts } from './storage';
import type { GetAuth, LoaderResult, PluginClient, Provider } from './types';
export interface AuthFetchRuntime {
    fetch: LoaderResult['fetch'];
    dispose(): Promise<void> | void;
}
export type CreateAuthFetch = (input: {
    accountManager: AccountManager;
    getAuth: GetAuth;
}) => AuthFetchRuntime;
/**
 * Loader returned by `createAuthLoader`. The function loads the
 * account pool from disk and installs the runtime.
 */
export type LoadAndInstallRuntime = (getAuth: GetAuth, provider: Provider) => Promise<LoaderResult | Record<string, unknown>>;
/**
 * Reload the live AccountManager + fetch runtime without going through
 * the full startup loader. Used by the OAuth add flow so the new account
 * is visible to routing immediately after `persistAccountPool`.
 */
export type ReloadAccountRuntime = (getAuth: GetAuth) => Promise<void>;
export interface AuthLoaderHandle {
    load: LoadAndInstallRuntime;
    reload: ReloadAccountRuntime;
}
interface AuthLoaderDependencies {
    loadAccounts: typeof loadAccounts;
    clearAccounts: typeof clearAccounts;
    loadAccountManager(auth: Parameters<typeof AccountManager.loadFromDisk>[0]): Promise<AccountManager>;
    createRefreshQueue: typeof createProactiveRefreshQueue;
    isDebugEnabled: typeof isDebugEnabled;
    getLogFilePath: typeof getLogFilePath;
}
interface CreateAuthLoaderOptions {
    client: PluginClient;
    providerId: string;
    config: AntigravityConfig;
    lifecycle: PluginLifecycle;
    createFetch: CreateAuthFetch;
    onGetAuth?(getAuth: GetAuth): void;
    dependencies?: Partial<AuthLoaderDependencies>;
}
export declare function createAuthLoader({ client, providerId, config, lifecycle, createFetch, onGetAuth, dependencies, }: CreateAuthLoaderOptions): LoadAndInstallRuntime & AuthLoaderHandle;
export {};
//# sourceMappingURL=auth-loader.d.ts.map