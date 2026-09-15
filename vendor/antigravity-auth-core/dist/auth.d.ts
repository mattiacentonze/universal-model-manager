import type { OAuthAuthDetails, RefreshParts } from './auth-types.ts';
export declare function isOAuthAuth(auth: unknown): auth is OAuthAuthDetails;
/**
 * Splits a packed refresh string into its constituent refresh token and project IDs.
 */
export declare function parseRefreshParts(refresh: string): RefreshParts;
/**
 * Serializes refresh token parts into the stored string format.
 */
export declare function formatRefreshParts(parts: RefreshParts): string;
/**
 * Determines whether an access token is expired or missing, with buffer for clock skew.
 */
export declare function accessTokenExpired(auth: OAuthAuthDetails): boolean;
/**
 * Calculates absolute expiry timestamp based on a duration.
 * @param requestTimeMs The local time when the request was initiated
 * @param expiresInSeconds The duration returned by the server
 */
export declare function calculateTokenExpiry(requestTimeMs: number, expiresInSeconds: unknown): number;
//# sourceMappingURL=auth.d.ts.map