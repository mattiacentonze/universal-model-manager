/**
 * Result returned to the caller after constructing an OAuth authorization URL.
 */
export interface AntigravityAuthorization {
    url: string;
    verifier: string;
    projectId: string;
}
interface AntigravityTokenExchangeSuccess {
    type: 'success';
    refresh: string;
    access: string;
    expires: number;
    email?: string;
    label?: string;
    projectId: string;
}
interface AntigravityTokenExchangeFailure {
    type: 'failed';
    error: string;
}
export type AntigravityTokenExchangeResult = AntigravityTokenExchangeSuccess | AntigravityTokenExchangeFailure;
export interface AntigravityRefreshResult {
    access: string;
    refresh: string;
    expires: number;
}
/**
 * Refresh an Antigravity OAuth access token using a bare refresh token.
 * Harness-agnostic: performs only the token POST and returns the new
 * credentials. Persistence/caching is the caller's responsibility.
 */
export declare function refreshAntigravityToken(refreshToken: string): Promise<AntigravityRefreshResult>;
/**
 * Build the Antigravity OAuth authorization URL including PKCE and optional project metadata.
 */
export declare function authorizeAntigravity(projectId?: string): Promise<AntigravityAuthorization>;
/**
 * Exchange an authorization code for Antigravity CLI access and refresh tokens.
 */
export declare function exchangeAntigravity(code: string, state: string): Promise<AntigravityTokenExchangeResult>;
export {};
//# sourceMappingURL=oauth.d.ts.map