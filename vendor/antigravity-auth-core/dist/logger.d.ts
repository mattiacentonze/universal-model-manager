/**
 * Harness-agnostic structured logger for the Antigravity core.
 *
 * Core code never talks to a specific harness UI. Instead it emits log
 * records to a pluggable sink. Harnesses (OpenCode, pi) register their own
 * sink via `setLogSink()` to route logs into their TUI/log panel. When no
 * sink is registered, an env-gated console fallback is used.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
    debug(message: string, extra?: Record<string, unknown>): void;
    info(message: string, extra?: Record<string, unknown>): void;
    warn(message: string, extra?: Record<string, unknown>): void;
    error(message: string, extra?: Record<string, unknown>): void;
}
export interface LogRecord {
    service: string;
    level: LogLevel;
    message: string;
    extra?: Record<string, unknown>;
}
export type LogSink = (record: LogRecord) => void;
/**
 * Register the harness-specific log sink. Pass `null` to clear it.
 */
export declare function setLogSink(sink: LogSink | null): void;
/**
 * Create a logger for a specific module. Records are forwarded to the
 * registered sink, with an env-gated console fallback.
 */
export declare function createLogger(module: string): Logger;
//# sourceMappingURL=logger.d.ts.map