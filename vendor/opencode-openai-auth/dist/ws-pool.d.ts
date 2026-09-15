export declare const TITLE_HEADER = "x-opencode-title";
export declare const QUOTA_ACCOUNT_HEADER = "x-openai-auth-quota-account";
export interface CreateWebSocketFetchOptions {
    httpFetch?: typeof globalThis.fetch;
    url?: string;
    connectTimeout?: number;
    idleTimeout?: number;
    maxConnectionAge?: number;
    streamRetries?: number;
    /** Milliseconds to wait for an immediate provider-side WS error before returning response headers. */
    firstEventGraceMs?: number;
    /** Use the hand-rolled raw TCP/TLS WebSocket client instead of native WebSocket. */
    rawWebSocket?: boolean;
    /**
     * Push per-turn quota from a codex.rate_limits in-band frame.
     *
     * Receives the snapshot plus the per-request account identity (access token,
     * internal quota account key, and served ChatGPT account id) captured at send
     * time so the frame is attributed to the connection's own account, not a
     * shared mutable global.
     */
    onQuota?: (s: Record<string, unknown>, accessToken: string, accountId: string | undefined, servedChatgptAccountId: string | undefined) => void;
    /** Receives quota exhaustion plus the account identity captured at send time. */
    onRateLimitReached?: (window: string, accountId: string | undefined, resetAt?: number) => void;
}
interface PoolEntry {
    socket?: WebSocket;
    connectedAt?: number;
    lastUsedAt: number;
    busy: boolean;
    fallback: boolean;
    streamFailures: number;
    continuation?: ContinuationState;
    turnID?: string;
    turnStartedAt?: number;
    turnInput?: unknown[];
    turnSignature?: string;
}
interface ContinuationState {
    responseID: string;
    input: unknown[];
    signature: string;
    finalizedCallIds: Set<string>;
}
export declare function createWebSocketFetch(options?: CreateWebSocketFetchOptions): ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & {
    close: () => void;
    remove: (sessionID: string) => void;
};
export declare const CODEX_BODY_KEY_ORDER: string[];
export declare function orderCodexBody(body: Record<string, unknown>): Record<string, unknown>;
export declare function advanceTurn(entry: PoolEntry, body: Record<string, unknown>, fullBody?: Record<string, unknown>): void;
export declare function applyTurnId(entry: PoolEntry, body: Record<string, unknown>, fullBody?: Record<string, unknown>): Record<string, unknown>;
export { hasWebSocketResponsesLiteMetadata, sanitizeHttpFallbackBody, } from './codex-http';
export declare function withoutInternalHeaders<T extends {
    headers?: HeadersInit;
}>(init: T | undefined): T | undefined;
export * as OpenAIWebSocketPool from './ws-pool';
