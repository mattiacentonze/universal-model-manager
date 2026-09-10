import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { getChatGptStorageStatePath } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

export interface CookieItem {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface StorageState {
  cookies: CookieItem[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export class SessionStore {
  constructor(private readonly filePath = getChatGptStorageStatePath()) {}

  hasValidSession(): boolean {
    if (!existsSync(this.filePath)) return false;
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf8")) as StorageState;
      if (!Array.isArray(data.cookies)) return false;
      const now = Date.now() / 1000;
      // Look for session-like cookies for chatgpt.com or openai.com
      const hasAuthCookie = data.cookies.some(
        c => (c.domain.includes("chatgpt.com") || c.domain.includes("openai.com")) &&
             (c.name.includes("session") || c.name.includes("token") || c.name.startsWith("__Secure-")) &&
             (c.expires === -1 || c.expires > now)
      );
      return hasAuthCookie || data.cookies.length > 3;
    } catch {
      return false;
    }
  }

  load(): StorageState | undefined {
    if (!existsSync(this.filePath)) return undefined;
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as StorageState;
    } catch (err) {
      logger.warn(`Failed to read storage state from ${this.filePath}: ${err}`);
      return undefined;
    }
  }

  save(state: StorageState): void {
    const json = JSON.stringify(state, null, 2);
    writeFileSync(this.filePath, json, { mode: 0o600 });
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // Ignored if chmod not supported on current filesystem
    }
    logger.info(`Session state saved safely to ${this.filePath}`);
  }
}
