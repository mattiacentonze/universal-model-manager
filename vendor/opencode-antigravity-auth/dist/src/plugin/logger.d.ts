/**
 * Structured Logger for Antigravity Plugin
 *
 * Logging behavior:
 * - debug controls file logs only (via debug.ts)
 * - debug_tui controls TUI log panel only
 * - either sink can be enabled independently
 * - OPENCODE_ANTIGRAVITY_CONSOLE_LOG=1 → console output (independent of debug flags)
 * - operator.log_level filters the level at which log entries are emitted
 */
import type { OperatorSettings } from './operator-settings';
import type { PluginClient } from './types';
export interface Logger {
    debug(message: string, extra?: Record<string, unknown>): void;
    info(message: string, extra?: Record<string, unknown>): void;
    warn(message: string, extra?: Record<string, unknown>): void;
    error(message: string, extra?: Record<string, unknown>): void;
}
/**
 * Set the runtime log level. Reads from the operator settings controller
 * on each call so a /antigravity-logging dialog flip takes effect
 * immediately. Falls back to "debug" when the operator level is not
 * yet known.
 */
export declare function setRuntimeLogLevel(level: OperatorSettings['log_level']): void;
/**
 * Initialize the logger with the plugin client.
 * Must be called during plugin initialization to enable TUI logging.
 */
export declare function initLogger(client: PluginClient): void;
export declare function createLogger(module: string): Logger;
//# sourceMappingURL=logger.d.ts.map