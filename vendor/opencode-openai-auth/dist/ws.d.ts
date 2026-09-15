import { ResponseStreamError } from './response-stream-error';
export declare const PROTOCOL_HEADER = "responses_websockets=2026-02-06";
export interface ConnectResponsesWebSocketOptions {
    url: string;
    headers: Record<string, string>;
    timeout?: number;
    /** Use the hand-rolled raw TCP/TLS WebSocket client instead of native WebSocket. */
    rawWebSocket?: boolean;
    signal?: AbortSignal;
}
export interface StreamResponsesWebSocketOptions {
    socket: WebSocket;
    body: Record<string, unknown>;
    sessionID?: string;
    idleTimeout?: number;
    signal?: AbortSignal;
    onFirstEvent?: (error?: WrappedError) => void;
    /**
     * Fires on response.completed/response.done. `finalizedFunctionCallIds` is the
     * set of function/custom tool call ids the response actually finalized (emitted
     * a response.output_item.done for). The pool uses it to decide which suffix
     * function_call items are safe to trim from a continuation: only those present
     * in the chained response may be dropped — an unfinalized call (e.g. an aborted
     * partial) must be kept inline or its function_call_output orphans → 400.
     */
    onComplete?: (event: Record<string, unknown>, finalizedFunctionCallIds: Set<string>) => void;
    onTerminal?: (event: Record<string, unknown>) => void;
    onRetryableTerminal?: (event: Record<string, unknown>) => Promise<WebSocket | undefined>;
    onConnectionInvalid?: (error: ResponseStreamError) => void;
    onAbort?: (error: Error) => void;
    /** Push per-turn quota from a codex.rate_limits in-band frame. */
    onQuota?: (s: Record<string, unknown>) => void;
    /** Called when the transport reports quota exhaustion for the current connection. */
    onRateLimitReached?: (window: string, resetAt?: number) => void;
}
export interface WrappedError {
    status: number;
    headers?: Record<string, string>;
    body: string;
}
export declare function toWebSocketUrl(url: string): string;
export declare function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string>;
export declare function isAbortError(error: unknown): error is DOMException;
export declare function isUpgradeFailure(error: unknown): boolean;
export declare function isOversizedFrame(error: unknown): boolean;
export declare function markOversizedFrame<T extends object>(error: T): T;
export declare function connectResponsesWebSocket(options: ConnectResponsesWebSocketOptions): Promise<WebSocket>;
export declare function streamResponsesWebSocket(options: StreamResponsesWebSocketOptions): Response;
export declare function parseRateLimitSignal(value: unknown): {
    window: string;
    resetAt?: number;
} | undefined;
export * as OpenAIWebSocket from './ws';
