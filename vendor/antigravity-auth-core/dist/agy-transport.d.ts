import { Buffer } from 'node:buffer';
import { Transform } from 'node:stream';
export declare const DEFAULT_AGY_RESPONSE_HEADER_TIMEOUT_MS = 180000;
export declare const DEFAULT_AGY_IDLE_TIMEOUT_MS = 180000;
export type AgyTransportOptions = {
    /**
     * Maximum time to wait for the request to connect and receive HTTP response headers.
     * The response body/stream is not bounded by this timeout.
     */
    timeoutMs?: number;
    /**
     * Maximum time the response body may stall (no bytes) before the socket is
     * destroyed. Resets on every received chunk. Defaults to
     * DEFAULT_AGY_IDLE_TIMEOUT_MS.
     */
    idleTimeoutMs?: number;
    signal?: AbortSignal | null;
    onDebug?: (message: string) => void;
};
type HeaderPair = readonly [string, string];
export declare function buildAgyCliHeaderPairs(url: string, init?: RequestInit): HeaderPair[];
export declare class ContentLengthStream extends Transform {
    private remaining;
    constructor(contentLength: number);
    _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void;
}
export declare function fetchWithAgyCliTransport(url: string, init?: RequestInit, options?: AgyTransportOptions): Promise<Response>;
export {};
//# sourceMappingURL=agy-transport.d.ts.map