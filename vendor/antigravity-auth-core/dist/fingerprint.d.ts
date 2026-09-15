/**
 * Device Fingerprint Generator for Rate Limit Mitigation
 *
 * Uses the agy CLI 1.1.24 content-request identity captured with mitmproxy:
 * an Antigravity CLI User-Agent with explicit client, OS, architecture, and auth metadata.
 * The stored deviceId/sessionToken fields are
 * retained for account history, but content requests only send User-Agent.
 */
export declare const AGY_CLI_VERSION = "1.1.24";
export declare const AGY_CLI_CHANGE_LIST = "974782877";
export interface ClientMetadata {
    ideType: string;
    platform: string;
    pluginType: string;
}
export interface Fingerprint {
    deviceId: string;
    sessionToken: string;
    userAgent: string;
    apiClient: string;
    clientMetadata: ClientMetadata;
    createdAt: number;
}
/**
 * Fingerprint version for history tracking.
 * Stores a snapshot of a fingerprint with metadata about when/why it was saved.
 */
export interface FingerprintVersion {
    fingerprint: Fingerprint;
    timestamp: number;
    reason: 'initial' | 'regenerated' | 'restored';
}
/** Maximum number of fingerprint versions to keep per account */
export declare const MAX_FINGERPRINT_HISTORY = 5;
export interface FingerprintHeaders {
    'User-Agent': string;
}
export declare function buildAntigravityHarnessPlatformArch(platform?: NodeJS.Platform, arch?: NodeJS.Architecture): string;
export declare function buildAntigravityHarnessUserAgent(version?: string, platform?: NodeJS.Platform, arch?: NodeJS.Architecture, authMethod?: string): string;
export declare function buildAntigravityHarnessLoadCodeAssistUserAgent(version?: string): string;
export declare function buildAntigravityLoadCodeAssistMetadata(): Record<string, string>;
export declare function buildAntigravityHarnessBootstrapHeaders(accessToken: string): Record<string, string>;
/**
 * Generate the per-account content-request fingerprint.
 * The outward HTTP identity is stable; deviceId/sessionToken remain unique for history.
 */
export declare function generateFingerprint(): Fingerprint;
/**
 * Collect the current content-request fingerprint.
 */
export declare function collectCurrentFingerprint(): Fingerprint;
/**
 * Update a saved fingerprint's User-Agent to the current Antigravity
 * agy CLI identity. This migrates older randomized fingerprints and the
 * pre-1.1.3 platform/arch-only User-Agent to the captured metadata form.
 * Returns true if the User-Agent was changed.
 */
export declare function updateFingerprintVersion(fingerprint: Fingerprint): boolean;
/**
 * Build HTTP headers from a fingerprint object.
 * These headers are used to identify the "device" making API requests.
 */
export declare function buildFingerprintHeaders(fingerprint: Fingerprint | null): Partial<FingerprintHeaders>;
/**
 * Get or create the session fingerprint.
 * Returns the same fingerprint for all calls within a session.
 */
export declare function getSessionFingerprint(): Fingerprint;
/**
 * Regenerate the session fingerprint.
 * Call this to get a fresh identity (e.g., after rate limiting).
 */
export declare function regenerateSessionFingerprint(): Fingerprint;
/**
 * Clear the cached session fingerprint so the next `getSessionFingerprint`
 * call generates a fresh one. Test-only escape hatch — production code should
 * use `regenerateSessionFingerprint` to also return the new value.
 */
export declare function clearSessionFingerprint(): void;
//# sourceMappingURL=fingerprint.d.ts.map