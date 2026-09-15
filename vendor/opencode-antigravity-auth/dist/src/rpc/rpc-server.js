import { randomBytes, timingSafeEqual } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { createServer, } from 'node:http';
import { join } from 'node:path';
import { writePortFile } from './port-file';
const LOOPBACK_HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 2_000;
const APPLY_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 1024 * 1024;
const APPLY_PATH = '/rpc/apply';
const NOTIFICATIONS_PATH = '/rpc/pending-notifications';
const HEALTH_PATH = '/health';
const COMMANDS = new Set([
    'antigravity-quota',
    'antigravity-account',
    'antigravity-routing',
    'antigravity-killswitch',
    'antigravity-dump',
    'antigravity-logging',
]);
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
export async function startRpcServer(options) {
    const token = randomBytes(32).toString('hex');
    const server = createServer((request, response) => {
        void handleRequest(request, response, token, options).catch((error) => {
            if (response.headersSent || response.writableEnded)
                return;
            if (error instanceof HttpError) {
                sendJson(response, error.status, { error: error.message });
                return;
            }
            sendJson(response, 500, { error: 'Internal RPC error' });
        });
    });
    server.headersTimeout = REQUEST_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    await new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, LOOPBACK_HOST);
    });
    // unref so the open TCP listener does not keep the host process alive
    // once the rest of the event loop has nothing else to do.
    server.unref();
    const address = server.address();
    if (!address) {
        await closeServer(server);
        throw new Error('RPC server started without a TCP address');
    }
    try {
        await writePortFile(options.dir, {
            pid: process.pid,
            port: address.port,
            token,
        });
    }
    catch (error) {
        await closeServer(server);
        throw error;
    }
    let stopping = null;
    return {
        port: address.port,
        token,
        stop() {
            if (!stopping) {
                stopping = (async () => {
                    await closeServer(server);
                    try {
                        await unlink(join(options.dir, `port-${process.pid}.json`));
                    }
                    catch (error) {
                        if (!isNodeError(error, 'ENOENT'))
                            throw error;
                    }
                })();
            }
            return stopping;
        },
    };
}
async function handleRequest(request, response, token, options) {
    const path = request.url
        ? new URL(request.url, 'http://localhost').pathname
        : '';
    if (request.method === 'GET' && path === HEALTH_PATH) {
        sendJson(response, 200, { ok: true });
        return;
    }
    if (request.method !== 'POST' ||
        (path !== APPLY_PATH && path !== NOTIFICATIONS_PATH)) {
        sendJson(response, 404, { error: 'Not found' });
        return;
    }
    if (!isAuthorized(request.headers.authorization, token)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
    }
    const body = await readJsonBody(request);
    if (path === APPLY_PATH) {
        const applyRequest = parseApplyRequest(body);
        const result = await withTimeout(Promise.resolve(options.apply(applyRequest)), APPLY_TIMEOUT_MS);
        sendJson(response, 200, result);
        return;
    }
    const pendingRequest = parsePendingRequest(body);
    const notifications = await options.drain(pendingRequest.lastReceivedId, pendingRequest.sessionId);
    sendJson(response, 200, { messages: notifications });
}
function isAuthorized(header, token) {
    const prefix = 'Bearer ';
    const provided = header?.startsWith(prefix) ? header.slice(prefix.length) : '';
    const expectedBytes = Buffer.from(token);
    const providedBytes = Buffer.from(provided);
    const padded = Buffer.alloc(expectedBytes.length);
    providedBytes.copy(padded, 0, 0, expectedBytes.length);
    const sameLength = providedBytes.length === expectedBytes.length;
    return timingSafeEqual(padded, expectedBytes) && sameLength;
}
async function readJsonBody(request) {
    const declaredLength = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        request.resume();
        throw new HttpError(413, 'Request body too large');
    }
    const chunks = [];
    let bytes = 0;
    await new Promise((resolve, reject) => {
        request.on('data', (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > MAX_BODY_BYTES) {
                request.removeAllListeners('data');
                request.on('data', () => { });
                request.resume();
                reject(new HttpError(413, 'Request body too large'));
                return;
            }
            chunks.push(buffer);
        });
        request.once('end', resolve);
        request.once('error', reject);
        request.once('aborted', () => reject(new HttpError(400, 'Request aborted')));
    });
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new HttpError(400, 'Invalid JSON');
    }
}
function parseApplyRequest(value) {
    if (!isRecord(value) ||
        typeof value.command !== 'string' ||
        !COMMANDS.has(value.command) ||
        typeof value.arguments !== 'string' ||
        (value.sessionId !== undefined && typeof value.sessionId !== 'string')) {
        throw new HttpError(400, 'Invalid apply request');
    }
    return value;
}
function parsePendingRequest(value) {
    if (!isRecord(value) ||
        !Number.isSafeInteger(value.lastReceivedId) ||
        value.lastReceivedId < 0 ||
        (value.sessionId !== undefined && typeof value.sessionId !== 'string')) {
        throw new HttpError(400, 'Invalid pending-notifications request');
    }
    return {
        lastReceivedId: value.lastReceivedId,
        ...(value.sessionId === undefined
            ? {}
            : { sessionId: value.sessionId }),
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sendJson(response, status, value) {
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(value));
}
async function withTimeout(promise, timeoutMs) {
    let timeout;
    const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new HttpError(504, 'RPC handler timed out')), timeoutMs);
        timeout.unref?.();
    });
    try {
        return await Promise.race([promise, deadline]);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error && !isNodeError(error, 'ERR_SERVER_NOT_RUNNING')) {
                reject(error);
                return;
            }
            resolve();
        });
        server.closeAllConnections?.();
    });
}
function isNodeError(error, code) {
    return (error instanceof Error &&
        'code' in error &&
        error.code === code);
}
//# sourceMappingURL=rpc-server.js.map