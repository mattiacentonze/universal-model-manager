import type { AntigravityTokenExchangeResult } from '../antigravity/oauth';
import { fetchWithAgyCliTransport } from './agy-transport';
import type { AccountMetadataV3, AccountStorageV4 } from './storage';
import { refreshAccessToken } from './token';
import type { PluginClient } from './types';
export type VerificationProbeResult = {
    status: 'ok';
    message: string;
} | {
    status: 'ineligible';
    message: string;
} | {
    status: 'verification-required';
    message: string;
    verifyUrl?: string;
} | {
    status: 'error';
    message: string;
};
export interface AccountIdentity {
    refreshToken?: string;
    email?: string;
}
export interface AccountAccessStore {
    load(): Promise<AccountStorageV4 | null>;
    mutate(mutate: (current: AccountStorageV4) => AccountStorageV4 | undefined | Promise<AccountStorageV4 | undefined>): Promise<AccountStorageV4>;
    clear(): Promise<void>;
    persistAccountPool(results: Array<Extract<AntigravityTokenExchangeResult, {
        type: 'success';
    }>>, replaceAll: boolean): Promise<void>;
}
export interface AccountAccessPrompt {
    selectAccount(accounts: Array<{
        email?: string;
        index: number;
    }>): Promise<number | undefined>;
    confirmOpenVerificationUrl(): Promise<boolean>;
}
export interface AccountAccessService {
    loadAccounts(): Promise<AccountStorageV4 | null>;
    mutateAccounts(mutate: (current: AccountStorageV4) => AccountStorageV4 | undefined | Promise<AccountStorageV4 | undefined>): Promise<AccountStorageV4>;
    clearAccounts(): Promise<void>;
    persistAccountPool(results: Array<Extract<AntigravityTokenExchangeResult, {
        type: 'success';
    }>>, replaceAll: boolean): Promise<void>;
    verifyAccount(account: {
        refreshToken: string;
        email?: string;
        projectId?: string;
        managedProjectId?: string;
    }): Promise<VerificationProbeResult>;
    applyVerificationResult(identity: AccountIdentity, result: VerificationProbeResult): Promise<void>;
    clearAccessBlocks(identity: AccountIdentity, enableIfBlocked?: boolean): Promise<{
        changed: boolean;
        wasAccessBlocked: boolean;
    }>;
    selectAccount(accounts: Array<{
        email?: string;
        index: number;
    }>): Promise<number | undefined>;
    openVerificationUrl(url: string): Promise<boolean>;
}
interface AccountAccessDependencies {
    refreshAccessToken: typeof refreshAccessToken;
    transport: typeof fetchWithAgyCliTransport;
}
interface CreateAccountAccessServiceOptions {
    client: PluginClient;
    providerId: string;
    store: AccountAccessStore;
    openBrowser(url: string): Promise<boolean>;
    prompt: AccountAccessPrompt;
    dependencies?: Partial<AccountAccessDependencies>;
}
export declare function normalizeGoogleVerificationUrl(rawUrl: string): string | undefined;
export declare function selectBestVerificationUrl(urls: string[]): string | undefined;
export declare function extractAccountAccessErrorDetails(bodyText: string): {
    validationRequired: boolean;
    accountIneligible: boolean;
    message?: string;
    verifyUrl?: string;
};
export declare function buildAccountAccessProbeRequest(projectId: string): Record<string, unknown>;
export declare function interpretAccountAccessProbeResponse(response: Response): Promise<VerificationProbeResult>;
type VerificationStoredAccount = AccountMetadataV3;
export declare function markStoredAccountVerificationRequired(account: VerificationStoredAccount, reason: string, verifyUrl?: string): boolean;
export declare function markStoredAccountIneligible(account: VerificationStoredAccount, reason: string): boolean;
export declare function clearStoredAccountAccessBlocks(account: VerificationStoredAccount, enableIfBlocked?: boolean): {
    changed: boolean;
    wasAccessBlocked: boolean;
};
export declare function createAccountAccessService({ client, providerId, store, openBrowser, prompt, dependencies, }: CreateAccountAccessServiceOptions): AccountAccessService;
export declare function promptAccountIndexForVerification(accounts: Array<{
    email?: string;
    index: number;
}>): Promise<number | undefined>;
export declare function promptOpenVerificationUrl(): Promise<boolean>;
export {};
//# sourceMappingURL=account-access.d.ts.map