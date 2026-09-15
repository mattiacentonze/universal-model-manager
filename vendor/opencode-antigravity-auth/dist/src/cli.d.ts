import type { AccountMetadataV3, AccountQuotaResult, AccountStorageV4 } from '@cortexkit/antigravity-auth-core';
import { type AntigravityTokenExchangeSuccess, type OAuthLoginRequest, performOAuthLogin } from './plugin/oauth-login';
interface WritableOutput {
    write(value: string): unknown;
}
export interface CliDependencies {
    stdout: WritableOutput;
    stderr: WritableOutput;
    prompt(message: string): Promise<string>;
    openBrowser(url: string): Promise<void>;
    isHeadless?(): boolean;
    performLogin(request: OAuthLoginRequest, openBrowser: (url: string) => Promise<void>): Promise<AntigravityTokenExchangeSuccess>;
    loadAccounts(): Promise<AccountStorageV4 | null>;
    getQuota(accounts: AccountMetadataV3[], options: {
        refresh: boolean;
    }): Promise<AccountQuotaResult[]>;
}
export declare function runCli(argv: string[], deps: CliDependencies): Promise<number>;
export declare function createDefaultCliDependencies(): CliDependencies;
export { performOAuthLogin };
//# sourceMappingURL=cli.d.ts.map