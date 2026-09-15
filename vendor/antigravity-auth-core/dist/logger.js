/**
 * Harness-agnostic structured logger for the Antigravity core.
 *
 * Core code never talks to a specific harness UI. Instead it emits log
 * records to a pluggable sink. Harnesses (OpenCode, pi) register their own
 * sink via `setLogSink()` to route logs into their TUI/log panel. When no
 * sink is registered, an env-gated console fallback is used.
 */
const ENV_CONSOLE_LOG = 'ANTIGRAVITY_CORE_CONSOLE_LOG';
let _sink = null;
/**
 * Register the harness-specific log sink. Pass `null` to clear it.
 */
export function setLogSink(sink) {
    _sink = sink;
}
function isTruthyFlag(flag) {
    return flag === '1' || flag?.toLowerCase() === 'true';
}
function isConsoleLogEnabled() {
    return isTruthyFlag(process.env[ENV_CONSOLE_LOG]);
}
function writeConsoleLog(level, ...args) {
    switch (level) {
        case 'debug':
            console.debug(...args);
            break;
        case 'info':
            console.info(...args);
            break;
        case 'warn':
            console.warn(...args);
            break;
        case 'error':
            console.error(...args);
            break;
    }
}
/**
 * Create a logger for a specific module. Records are forwarded to the
 * registered sink, with an env-gated console fallback.
 */
export function createLogger(module) {
    const service = `antigravity.${module}`;
    const log = (level, message, extra) => {
        if (_sink) {
            try {
                _sink({ service, level, message, extra });
            }
            catch {
                // Never let logging failures break core logic.
            }
        }
        if (isConsoleLogEnabled()) {
            const prefix = `[${service}]`;
            const args = extra ? [prefix, message, extra] : [prefix, message];
            writeConsoleLog(level, ...args);
        }
    };
    return {
        debug: (message, extra) => log('debug', message, extra),
        info: (message, extra) => log('info', message, extra),
        warn: (message, extra) => log('warn', message, extra),
        error: (message, extra) => log('error', message, extra),
    };
}
//# sourceMappingURL=logger.js.map