/**
 * Provider injection seam — shared types and the 2 Codex provider fns.
 *
 * Both fns are constructor-injected into FallbackAccountManager and
 * QuotaManager so the generic core never imports provider specifics
 * directly.
 */
import type { OAuthQuotaSnapshot } from './accounts.ts';
declare const log: {
    error: (m: string, d?: unknown) => void;
    warn: (m: string, d?: unknown) => void;
    info: (m: string, d?: unknown) => void;
    debug: (m: string, d?: unknown) => void;
    trace: (m: string, d?: unknown) => void;
};
type QuotaLogger = Pick<typeof log, 'debug' | 'warn'>;
export type QuotaWindowName = string;
export declare const PRIMARY: QuotaWindowName;
export declare const SECONDARY: QuotaWindowName;
export interface ProviderHttpError extends Error {
    status?: number;
    retryAfter?: number;
    /** True when this error originated from a token-refresh call (not a quota fetch). */
    isRefreshError?: boolean;
}
export type ProviderRefreshFn = (input: {
    refreshToken: string;
    fetchImpl: typeof fetch;
    now: () => number;
}) => Promise<{
    access: string;
    refresh: string;
    expires: number;
    expiresIn: number;
}>;
export type ProviderQuotaFn = (input: {
    accessToken: string;
    fetchImpl: typeof fetch;
    now: () => number;
}) => Promise<OAuthQuotaSnapshot>;
export declare const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export declare const CODEX_ISSUER = "https://auth.openai.com";
/**
 * Core Codex OAuth refresh — the single entry point for refreshing an
 * OpenAI OAuth token.  Used by both the legacy refreshAccessToken in
 * index.ts AND the FallbackAccountManager (via constructor injection).
 *
 * Throws a ProviderHttpError carrying `.status` (from the HTTP response)
 * and `.retryAfter` (parsed from Retry-After) so backoff machinery can
 * duck-type them without instanceof checks.
 */
export declare function codexRefreshFn(input: {
    refreshToken: string;
    fetchImpl: typeof fetch;
    now: () => number;
}): Promise<{
    access: string;
    refresh: string;
    expires: number;
    expiresIn: number;
}>;
export declare function whamUsageFn(input: {
    accessToken: string;
    fetchImpl: typeof fetch;
    now: () => number;
    accountId?: string;
    accountKey?: string;
    logger?: QuotaLogger;
}): Promise<OAuthQuotaSnapshot>;
export {};
