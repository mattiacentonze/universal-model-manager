/**
 * Stream-safe active-fetch timeout helper.
 *
 * Bounds the time spent waiting for HTTP response headers while leaving any
 * returned response body fully readable until the caller (or its own signal)
 * chooses to abort it. Naively forwarding `AbortSignal.timeout(...)` into
 * `fetch()` aborts the body at the deadline even when headers arrived
 * promptly — the helper only forwards the timeout into the request signal
 * until the underlying fetch resolves, then drops the timeout listener so
 * the body remains consumable.
 */
export declare const ACTIVE_FETCH_TIMEOUT_MS = 15000;
export type ActiveFetchOptions = {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
};
/**
 * Issue an HTTP fetch with a bounded active-fetch (header) wait.
 *
 * The `init.signal` is composed into the request abort signal so caller
 * cancellation still propagates, but the 15s active timeout is only enforced
 * until `fetchImpl` resolves — once headers arrive the timeout listener is
 * removed and the returned Response body can be streamed past the deadline.
 */
export declare function fetchWithActiveTimeout(input: RequestInfo | URL, init?: RequestInit, options?: ActiveFetchOptions): Promise<Response>;
//# sourceMappingURL=fetch-timeout.d.ts.map