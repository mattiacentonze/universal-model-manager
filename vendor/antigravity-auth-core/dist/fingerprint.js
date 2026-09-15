/**
 * Device Fingerprint Generator for Rate Limit Mitigation
 *
 * Uses the agy CLI 1.1.24 content-request identity captured with mitmproxy:
 * an Antigravity CLI User-Agent with explicit client, OS, architecture, and auth metadata.
 * The stored deviceId/sessionToken fields are
 * retained for account history, but content requests only send User-Agent.
 */
import * as crypto from 'node:crypto';
export const AGY_CLI_VERSION = '1.1.24';
export const AGY_CLI_CHANGE_LIST = '974782877';
const ANTIGRAVITY_API_CLIENT = 'antigravity-cli';
/** Maximum number of fingerprint versions to keep per account */
export const MAX_FINGERPRINT_HISTORY = 5;
function normalizeHarnessPlatform(platform = process.platform) {
    return platform === 'win32' ? 'windows' : platform || 'unknown';
}
function normalizeHarnessArch(arch = process.arch) {
    switch (arch) {
        case 'x64':
            return 'amd64';
        case 'ia32':
            return '386';
        default:
            return arch || 'unknown';
    }
}
export function buildAntigravityHarnessPlatformArch(platform = process.platform, arch = process.arch) {
    return `${normalizeHarnessPlatform(platform)}/${normalizeHarnessArch(arch)}`;
}
export function buildAntigravityHarnessUserAgent(version = AGY_CLI_VERSION, platform = process.platform, arch = process.arch, authMethod = 'consumer') {
    const osType = normalizeHarnessPlatform(platform);
    const normalizedArch = normalizeHarnessArch(arch);
    const changeList = version === AGY_CLI_VERSION ? `; cl=${AGY_CLI_CHANGE_LIST}` : '';
    return `antigravity/cli/${version} (aidev_client; os_type=${osType}; arch=${normalizedArch}${changeList}; auth_method=${authMethod})`;
}
export function buildAntigravityHarnessLoadCodeAssistUserAgent(version = AGY_CLI_VERSION) {
    return buildAntigravityHarnessUserAgent(version);
}
function platformToMetadataPlatform(platform = process.platform) {
    return platform === 'win32' ? 'WINDOWS' : 'MACOS';
}
export function buildAntigravityLoadCodeAssistMetadata() {
    return { ideType: 'ANTIGRAVITY' };
}
export function buildAntigravityHarnessBootstrapHeaders(accessToken) {
    return {
        'User-Agent': buildAntigravityHarnessLoadCodeAssistUserAgent(),
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip',
    };
}
function generateDeviceId() {
    return crypto.randomUUID();
}
function generateSessionToken() {
    return crypto.randomBytes(16).toString('hex');
}
/**
 * Generate the per-account content-request fingerprint.
 * The outward HTTP identity is stable; deviceId/sessionToken remain unique for history.
 */
export function generateFingerprint() {
    return {
        deviceId: generateDeviceId(),
        sessionToken: generateSessionToken(),
        userAgent: buildAntigravityHarnessUserAgent(),
        apiClient: ANTIGRAVITY_API_CLIENT,
        clientMetadata: {
            ideType: 'ANTIGRAVITY',
            platform: platformToMetadataPlatform(),
            pluginType: 'GEMINI',
        },
        createdAt: Date.now(),
    };
}
/**
 * Collect the current content-request fingerprint.
 */
export function collectCurrentFingerprint() {
    return generateFingerprint();
}
/**
 * Update a saved fingerprint's User-Agent to the current Antigravity
 * agy CLI identity. This migrates older randomized fingerprints and the
 * pre-1.1.3 platform/arch-only User-Agent to the captured metadata form.
 * Returns true if the User-Agent was changed.
 */
export function updateFingerprintVersion(fingerprint) {
    const userAgent = buildAntigravityHarnessUserAgent();
    if (fingerprint.userAgent === userAgent) {
        return false;
    }
    fingerprint.userAgent = userAgent;
    return true;
}
/**
 * Build HTTP headers from a fingerprint object.
 * These headers are used to identify the "device" making API requests.
 */
export function buildFingerprintHeaders(fingerprint) {
    if (!fingerprint) {
        return {};
    }
    return {
        'User-Agent': fingerprint.userAgent,
    };
}
/**
 * Session-level fingerprint instance.
 * Generated once at module load, persists for the lifetime of the process.
 */
let sessionFingerprint = null;
/**
 * Get or create the session fingerprint.
 * Returns the same fingerprint for all calls within a session.
 */
export function getSessionFingerprint() {
    if (!sessionFingerprint) {
        sessionFingerprint = generateFingerprint();
    }
    return sessionFingerprint;
}
/**
 * Regenerate the session fingerprint.
 * Call this to get a fresh identity (e.g., after rate limiting).
 */
export function regenerateSessionFingerprint() {
    sessionFingerprint = generateFingerprint();
    return sessionFingerprint;
}
/**
 * Clear the cached session fingerprint so the next `getSessionFingerprint`
 * call generates a fresh one. Test-only escape hatch — production code should
 * use `regenerateSessionFingerprint` to also return the new value.
 */
export function clearSessionFingerprint() {
    sessionFingerprint = null;
}
//# sourceMappingURL=fingerprint.js.map