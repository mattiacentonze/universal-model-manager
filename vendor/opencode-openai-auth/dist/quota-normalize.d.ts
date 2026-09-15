import type { OAuthQuotaSnapshot } from './core/accounts.ts';
export declare function toResetIso(raw: string | number | undefined): string | undefined;
export declare function normalizeQuotaHeaders(h: Headers): OAuthQuotaSnapshot;
/**
 * A complete frame has at least one syntactically valid used-percent header
 * and no malformed used-percent headers. Explicit retired-slot markers count
 * as valid even though normalization omits them from the snapshot.
 */
export declare function isCompleteQuotaHeaderFrame(h: Headers): boolean;
interface WsRateLimitWindow {
    used_percent: number;
    window_minutes: number;
    reset_at?: string | number;
}
interface WsRateLimits {
    primary?: WsRateLimitWindow | null;
    secondary?: WsRateLimitWindow | null;
}
interface WsRateLimitsFrame {
    type: string;
    rate_limits: WsRateLimits;
    plan_type?: string;
}
export declare function normalizeWsFrame(event: WsRateLimitsFrame): OAuthQuotaSnapshot;
interface WhamRateLimitWindow {
    used_percent: number;
    limit_window_seconds: number;
    reset_at?: string | number;
}
interface WhamRateLimits {
    primary_window?: WhamRateLimitWindow | null;
    secondary_window?: WhamRateLimitWindow | null;
}
interface WhamUsageResponse {
    plan_type?: string;
    rate_limit: WhamRateLimits;
    rate_limit_reset_credits?: {
        available_count?: number;
        applicable_available_count?: number;
    } | null;
}
export declare function normalizeWham(json: WhamUsageResponse): OAuthQuotaSnapshot;
export {};
