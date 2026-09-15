export declare const NON_TRANSIENT_REFRESH_RETRY_DELAY_MS: number;
export declare function isTransientRefreshError(error: unknown): boolean;
export declare function isTransientQuotaError(error: unknown): boolean;
export declare function hashRefreshToken(refreshToken: string): string;
export declare function buildRefreshOperationError(input: {
    error: unknown;
    now: number;
    refreshToken: string;
    previous?: {
        message: string;
        checkedAt: number;
        nextRetryAt?: number;
        retryCount?: number;
        tokenHash?: string;
    };
}): {
    message: string;
    checkedAt: number;
    nextRetryAt: number;
    retryCount: number;
    tokenHash: string;
};
export declare function refreshBackoffActive(error: {
    nextRetryAt?: number;
    tokenHash?: string;
} | undefined, refreshToken: string | undefined, now: number): boolean;
export declare function formatRefreshBackoffMessage(error: {
    message: string;
    nextRetryAt?: number;
}, now: number): string;
export declare function buildQuotaOperationError(input: {
    error: unknown;
    now: number;
    previous?: {
        message: string;
        checkedAt: number;
        nextRetryAt?: number;
        retryCount?: number;
    };
}): {
    message: string;
    checkedAt: number;
    nextRetryAt: number;
    retryCount: number;
};
export declare function quotaBackoffActive(error: {
    nextRetryAt?: number;
} | undefined, now: number): boolean;
export declare function formatQuotaBackoffMessage(error: {
    message: string;
    nextRetryAt?: number;
}, now: number): string;
export declare function parseRetryAfter(value: string | undefined | null): number | undefined;
