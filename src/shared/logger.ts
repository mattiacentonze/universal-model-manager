export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function redactSensitive(message: string): string {
  return message
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
    .replace(/(sess-[A-Za-z0-9._-]+)/gi, "[REDACTED_SESSION]")
    .replace(/(sk-[A-Za-z0-9._-]{20,})/gi, "[REDACTED_API_KEY]")
    .replace(/(cookie:\s*)([^\r\n]+)/gi, "$1[REDACTED_COOKIES]");
}

export class Logger {
  constructor(private readonly prefix: string = "universal-auth", private level: LogLevel = "info") {
    if (process.env.DEBUG || process.env.UNIVERSAL_AUTH_DEBUG === "1") {
      this.level = "debug";
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_WEIGHTS[level] >= LEVEL_WEIGHTS[this.level];
  }

  debug(msg: string, ...args: unknown[]) {
    if (this.shouldLog("debug")) {
      console.debug(`[${this.prefix}] [DEBUG] ${redactSensitive(msg)}`, ...args);
    }
  }

  info(msg: string, ...args: unknown[]) {
    if (this.shouldLog("info")) {
      console.info(`[${this.prefix}] [INFO] ${redactSensitive(msg)}`, ...args);
    }
  }

  warn(msg: string, ...args: unknown[]) {
    if (this.shouldLog("warn")) {
      console.warn(`[${this.prefix}] [WARN] ${redactSensitive(msg)}`, ...args);
    }
  }

  error(msg: string, ...args: unknown[]) {
    if (this.shouldLog("error")) {
      console.error(`[${this.prefix}] [ERROR] ${redactSensitive(msg)}`, ...args);
    }
  }
}

export const logger = new Logger();
