type Level = 'error' | 'warn' | 'info' | 'debug' | 'trace';
export declare function setLogLevel(l: Level | undefined): void;
export declare function redact(value: unknown): unknown;
/**
 * Scrub credential-shaped strings without redacting by key name.
 *
 * For regions where a key names a piece of data rather than holding a secret —
 * a JSON Schema property called `api_key` describes an argument, it does not
 * carry one — replacing the node by name destroys the structure while removing
 * nothing sensitive. A credential pasted into a description is still caught,
 * because that is a string.
 */
export declare function redactStrings(value: unknown): unknown;
export declare function createLogger(channel: string): {
    error: (m: string, d?: unknown) => void;
    warn: (m: string, d?: unknown) => void;
    info: (m: string, d?: unknown) => void;
    debug: (m: string, d?: unknown) => void;
    trace: (m: string, d?: unknown) => void;
};
export declare function flushForTest(): Promise<void>;
export {};
