type Listener = (event: unknown) => void;
export declare class RawWebSocket {
    url: string;
    readyState: number;
    private socket;
    private readonly sessionID;
    private listeners;
    private rxBuffer;
    private handshakeDone;
    private upgradeFailureEmitted;
    private expectedAccept;
    private fragOpcode;
    private fragChunks;
    constructor(url: string, headers: Record<string, string>, options?: {
        sessionID?: string;
    });
    addEventListener(type: string, fn: Listener, _opts?: {
        once?: boolean;
    }): void;
    removeEventListener(type: string, fn: Listener): void;
    /** Close code and reason from the peer's close frame, if one arrived. */
    private peerClose;
    private closeEmitted;
    /** Emit at most one close event, so the first reported code is the one kept. */
    private emitClose;
    private emit;
    private connect;
    private onData;
    private emitRejectedUpgrade;
    private drainFrames;
    private handleFrame;
    send(data: string): void;
    private writeFrame;
    close(): void;
    private log;
}
export {};
