export declare const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export declare const ISSUER = "https://auth.openai.com";
export declare const OAUTH_PORT = 1455;
export declare const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;
export declare const USER_AGENT = "cortexkit-opencode-openai-auth/0.7.1";
export declare const RESERVED_ACCOUNT_ID = "main";
export declare const RESERVED_ACCOUNT_ID_ERROR = "\"main\" is a reserved account id; choose a different label.";
export interface PkceCodes {
    verifier: string;
    challenge: string;
}
export declare function base64UrlEncode(buffer: ArrayBuffer): string;
export declare function generatePKCE(): Promise<PkceCodes>;
export interface IdTokenClaims {
    chatgpt_account_id?: string;
    email?: string;
    organizations?: Array<{
        id: string;
    }>;
    'https://api.openai.com/auth'?: {
        chatgpt_account_id?: string;
    };
}
export declare function parseJwtClaims(token: string): IdTokenClaims | undefined;
export declare function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined;
export interface TokenResponse {
    id_token: string;
    access_token: string;
    refresh_token: string;
    expires_in?: number;
}
export declare function extractAccountId(tokens: TokenResponse): string | undefined;
export declare function isReservedAccountId(value: string | undefined): boolean;
export declare function assertFallbackAccountIdAllowed<T extends string | undefined>(value: T): T;
export declare function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string;
export declare function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse>;
export declare function escapeHtml(value: string): string;
export declare const HTML_SUCCESS = "<!doctype html>\n<html>\n  <head>\n    <title>CortexKit OpenAI Auth - Authorization Successful</title>\n    <style>\n      body {\n        font-family:\n          system-ui,\n          -apple-system,\n          sans-serif;\n        display: flex;\n        justify-content: center;\n        align-items: center;\n        height: 100vh;\n        margin: 0;\n        background: #131010;\n        color: #f1ecec;\n      }\n      .container {\n        text-align: center;\n        padding: 2rem;\n      }\n      h1 {\n        color: #f1ecec;\n        margin-bottom: 1rem;\n      }\n      p {\n        color: #b7b1b1;\n      }\n    </style>\n  </head>\n  <body>\n    <div class=\"container\">\n      <h1>Authorization Successful</h1>\n      <p>You can close this window and return to OpenCode.</p>\n    </div>\n    <script>\n      setTimeout(() => window.close(), 2000)\n    </script>\n  </body>\n</html>";
export declare const HTML_ERROR: (error: string) => string;
export interface PendingOAuth {
    pkce: PkceCodes;
    state: string;
    resolve: (tokens: TokenResponse) => void;
    reject: (error: Error) => void;
}
export declare function flowCleanup(state: string): void;
export declare function startOAuthServer(): Promise<{
    port: number;
    redirectUri: string;
}>;
export declare function stopOAuthServer(): void;
export declare function resetOAuthStateForTest(): void;
export declare function waitForOAuthCallback(pkce: PkceCodes, state: string, timeoutMs?: number, signal?: AbortSignal): Promise<TokenResponse>;
export interface DeviceAuthInit {
    device_auth_id: string;
    user_code: string;
    interval: string;
    expires_in?: number | string;
}
export declare function beginDeviceAuth(): Promise<{
    deviceData: DeviceAuthInit;
    url: string;
    instructions: string;
}>;
export declare function completeDeviceAuth(deviceData: DeviceAuthInit, signal?: AbortSignal): Promise<TokenResponse>;
/**
 * Minimal shape of a fallback OAuth account for ingestion. Matches the
 * fields used by upsertAccount and beginAccountLogin, compatible with
 * the full OAuthAccount type in accounts.ts.
 */
export interface IngestAccount {
    id: string;
    label?: string;
    type: 'oauth';
    access?: string;
    refresh: string;
    expires?: number;
    enabled: boolean;
    addedAt: number;
    lastUsed: number;
    /**
     * When the token was obtained. Stamped at login so a freshly added account
     * carries a refresh marker — without it, the runtime-state merge cannot tell a
     * rotated token from a stale one (both default to 0) and a concurrent stale
     * save could roll the token back.
     */
    lastRefreshedAt?: number;
    /** Stable ChatGPT account identifier from the OAuth token claims. */
    accountId?: string;
}
export interface AccountStorageLike {
    version: 1;
    mainAccountId?: string;
    accounts: IngestAccount[];
}
/**
 * Dedup by stable accountId first (strongest signal — same ChatGPT account
 * added twice with different labels must merge), then by id, then by label.
 * If found, merge-update preserving addedAt. Otherwise push.
 * Re-running `add --label work` is idempotent.
 *
 * Accepts the accounts array directly (not the whole storage object) to
 * avoid coupling to any particular storage shape.
 */
export declare function upsertAccount<T extends {
    id: string;
    label?: string;
    accountId?: string;
    addedAt?: number;
}>(accounts: T[], account: T): number;
export interface BeginAccountLoginOptions {
    label?: string;
    headless?: boolean;
    signal?: AbortSignal;
}
export interface BeginAccountLoginResult {
    url: string;
    instructions: string;
    /** Resolves after the user completes the OAuth flow with a ready-to-ingest account. */
    completion: Promise<IngestAccount>;
}
/**
 * Split-return OAuth flow entry point.
 *
 * Browser flow (default):
 *   1. Start OAuth server, generate PKCE, build authorize URL
 *   2. Return { url, instructions, completion } — url is ready immediately
 *   3. completion resolves after browser callback + token exchange
 *
 * Headless flow:
 *   1. Begin device auth
 *   2. Return { url, instructions, completion }
 *   3. completion polls device endpoint + exchanges for tokens
 *
 * The split return allows the TUI command to show the URL before the
 * (potentially 30-60s) wait, avoiding a deadlock.
 */
export declare function beginAccountLogin(opts?: BeginAccountLoginOptions): Promise<BeginAccountLoginResult>;
