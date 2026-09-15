// Subpath import (not the barrel): this module ships into the TUI's
// compiled tree, which must not pull the credential-bearing barrel into
// the host's render path.
import { fetchWithActiveTimeout } from '@cortexkit/antigravity-auth-core/fetch-timeout';
import { discoverPortFile } from './port-file';
const DEFAULT_TIMEOUT_MS = 2_000;
const APPLY_FALLBACK = { text: 'apply failed', knobs: {} };
const PENDING_FALLBACK = [];
export function createRpcClient(dir, expectedPid) {
    return {
        async apply(request, options) {
            const result = await post(dir, expectedPid, '/rpc/apply', request, options);
            return result ?? APPLY_FALLBACK;
        },
        async pendingNotifications(lastReceivedId, sessionId, options) {
            const result = await post(dir, expectedPid, '/rpc/pending-notifications', {
                lastReceivedId,
                ...(sessionId === undefined ? {} : { sessionId }),
            }, options);
            return result?.messages ?? PENDING_FALLBACK;
        },
    };
}
async function post(dir, expectedPid, path, body, options) {
    // Internal nullable — every RPC call site (apply, pending) must absorb a
    // missing/unreachable server gracefully. The TUI render path never
    // crashes because the server is dead; the user sees a fallback text and
    // a fresh poll retries the next tick.
    const entry = await discoverPortFileSafe(dir, expectedPid);
    if (!entry)
        return null;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
        const response = await fetchWithActiveTimeout(`http://127.0.0.1:${entry.port}${path}`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${entry.token}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
        }, { timeoutMs });
        if (!response.ok)
            return null;
        return (await response.json());
    }
    catch {
        return null;
    }
}
async function discoverPortFileSafe(dir, expectedPid) {
    try {
        return await discoverPortFile(dir, expectedPid);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=rpc-client.js.map