import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

function writeLogLine(level: string, prefix: string, msg: string) {
  const sanitized = redactSensitive(msg);
  try {
    const logFile = join(homedir(), ".config", "opencode", "opencode-fallback.log");
    appendFileSync(logFile, `[${new Date().toISOString()}] [${prefix}] [${level}] ${sanitized}\n`);
  } catch {}

  // Only print to console if debug is enabled or in non-TTY/standalone CLI mode.
  // Never print raw console logs inside TUI interactive sessions to prevent input-bar corruption.
  if (
    process.env.DEBUG ||
    process.env.UNIVERSAL_AUTH_DEBUG === "1" ||
    (!process.stdout.isTTY && !process.env.OPENCODE_TUI)
  ) {
    console.log(`[${prefix}] [${level}] ${sanitized}`);
  }
}

export class Logger {
  constructor(
    private readonly prefix: string = "universal-auth",
    private level: LogLevel = "info",
  ) {
    if (process.env.DEBUG || process.env.UNIVERSAL_AUTH_DEBUG === "1") {
      this.level = "debug";
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_WEIGHTS[level] >= LEVEL_WEIGHTS[this.level];
  }

  debug(msg: string, ...args: unknown[]) {
    if (this.shouldLog("debug")) {
      writeLogLine("DEBUG", this.prefix, msg + (args.length ? ` ${JSON.stringify(args)}` : ""));
    }
  }

  info(msg: string, ...args: unknown[]) {
    if (this.shouldLog("info")) {
      writeLogLine("INFO", this.prefix, msg + (args.length ? ` ${JSON.stringify(args)}` : ""));
    }
  }

  warn(msg: string, ...args: unknown[]) {
    if (this.shouldLog("warn")) {
      writeLogLine("WARN", this.prefix, msg + (args.length ? ` ${JSON.stringify(args)}` : ""));
    }
  }

  error(msg: string, ...args: unknown[]) {
    if (this.shouldLog("error")) {
      writeLogLine("ERROR", this.prefix, msg + (args.length ? ` ${JSON.stringify(args)}` : ""));
    }
  }
}

export const logger = new Logger();
