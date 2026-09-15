export declare const DEFAULT_CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
/** Shape of ~/.config/opencode/openai-auth.json (all fields optional). */
export interface OpenAIAuthConfig {
    /** Inject the native web_search tool to keep the Codex prompt cache stable. Default true. */
    webSearch?: boolean;
    /** Use the WebSocket transport for /responses instead of plain HTTP. Default false. */
    webSockets?: boolean;
    /** Use the hand-rolled raw TCP/TLS WebSocket client (incremental streaming). Default false. */
    rawWebSocket?: boolean;
    /** Use Codex's Responses Lite request shape. Default false. */
    responsesLite?: boolean;
    /** Dump final Codex request bodies for cache debugging. Default false. */
    dump?: boolean | {
        enabled?: boolean;
    };
    /** Directory for request dumps. Defaults to the OS temp directory. */
    dumpDir?: string;
    /** Codex-compatible Responses endpoint. Defaults to ChatGPT's Codex backend. */
    codexApiEndpoint?: string;
}
export interface ResolvedSettings {
    webSearch: boolean;
    webSockets: boolean;
    rawWebSocket: boolean;
    responsesLite: boolean;
    dump: boolean;
    dumpDir: string;
    codexApiEndpoint: string;
}
export declare function getConfigDir(): string;
export declare function getConfigPath(): string;
/**
 * Resolved settings, memoized per process.
 *
 * Env and the config file are read once because neither changes under a running
 * process — except through a command that writes the config itself. Those
 * commands must call `refreshSettings()`, or the process keeps serving the
 * values it read at startup while the file on disk says otherwise.
 */
export declare function getSettings(): ResolvedSettings;
/**
 * Drop the memoized settings after a command writes the config file, so the
 * running process picks the change up without a restart.
 */
export declare function refreshSettings(): ResolvedSettings;
/** Test-only: drop the memoized settings so a later getSettings() re-reads env + config. */
export declare function resetSettingsForTest(): void;
