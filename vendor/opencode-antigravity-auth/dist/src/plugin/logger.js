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
import { setLogSink } from '@cortexkit/antigravity-auth-core';
import { isDebugTuiEnabled } from './debug';
import { isTruthyFlag, writeConsoleLog } from './logging-utils';
const ENV_CONSOLE_LOG = 'OPENCODE_ANTIGRAVITY_CONSOLE_LOG';
const LEVEL_PRIORITY = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
const LOG_LEVEL_FROM_OPERATOR = {
    error: 'error',
    warn: 'warn',
    info: 'info',
    debug: 'debug',
    trace: 'debug',
};
let _client = null;
let _configuredLevel = 'debug';
function shouldEmit(level) {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[_configuredLevel];
}
/**
 * Set the runtime log level. Reads from the operator settings controller
 * on each call so a /antigravity-logging dialog flip takes effect
 * immediately. Falls back to "debug" when the operator level is not
 * yet known.
 */
export function setRuntimeLogLevel(level) {
    _configuredLevel = LOG_LEVEL_FROM_OPERATOR[level] ?? 'debug';
}
/**
 * Initialize the logger with the plugin client.
 * Must be called during plugin initialization to enable TUI logging.
 */
export function initLogger(client) {
    _client = client;
    // Route core (@cortexkit/antigravity-auth-core) logs into the same TUI/console
    // sinks the OpenCode logger uses, so logs from migrated core modules surface.
    setLogSink(({ service, level, message, extra }) => {
        emitLog(service, level, message, extra);
    });
}
/**
 * Create a logger instance for a specific module.
 *
 * @param module - The module name (e.g., "refresh-queue", "transform.claude")
 * @returns Logger instance with debug, info, warn, error methods
 *
 * @example
 * ```typescript
 * const log = createLogger("refresh-queue");
 * log.debug("Checking tokens", { count: 5 });
 * log.warn("Token expired", { accountIndex: 0 });
 * ```
 */
function emitLog(service, level, message, extra) {
    if (!shouldEmit(level))
        return;
    // TUI logging: controlled only by debug_tui policy
    if (isDebugTuiEnabled()) {
        const app = _client?.app;
        if (app && typeof app.log === 'function') {
            app
                .log({
                body: { service, level, message, extra },
            })
                .catch(() => {
                // Silently ignore logging errors
            });
        }
    }
    // Console fallback: when env var is set (independent of debug flags)
    if (isConsoleLogEnabled()) {
        const prefix = `[${service}]`;
        const args = extra ? [prefix, message, extra] : [prefix, message];
        writeConsoleLog(level, ...args);
    }
    // If neither TUI nor console logging is enabled, log is silently discarded
}
function isConsoleLogEnabled() {
    return isTruthyFlag(process.env[ENV_CONSOLE_LOG]);
}
export function createLogger(module) {
    const service = `antigravity.${module}`;
    const log = (level, message, extra) => {
        emitLog(service, level, message, extra);
    };
    return {
        debug: (message, extra) => log('debug', message, extra),
        info: (message, extra) => log('info', message, extra),
        warn: (message, extra) => log('warn', message, extra),
        error: (message, extra) => log('error', message, extra),
    };
}
//# sourceMappingURL=logger.js.map