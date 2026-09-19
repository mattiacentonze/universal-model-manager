import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { logger } from "../shared/logger.js";
import { getChatGptStorageStatePath } from "../shared/paths.js";

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

export interface ChatGptAccountInfo {
  name?: string;
  email?: string;
  plan?: string;
  updatedAt?: string;
}

export class SessionStore {
  constructor(private readonly filePath = getChatGptStorageStatePath()) {}

  getAccountInfo(): ChatGptAccountInfo | null {
    const infoPath = this.filePath.replace(/\.json$/, "-info.json");
    if (!existsSync(infoPath)) return null;
    try {
      return JSON.parse(readFileSync(infoPath, "utf8"));
    } catch {
      return null;
    }
  }

  saveAccountInfo(info: ChatGptAccountInfo): void {
    const infoPath = this.filePath.replace(/\.json$/, "-info.json");
    try {
      writeFileSync(infoPath, JSON.stringify(info, null, 2), { mode: 0o600 });
      chmodSync(infoPath, 0o600);
    } catch {
      // Ignored if chmod not supported
    }
  }

  hasValidSession(): boolean {
    if (!existsSync(this.filePath)) return false;
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf8")) as StorageState;
      if (!Array.isArray(data.cookies)) return false;
      const now = Date.now() / 1000;
      // Look for real session-like auth cookies or user storage
      const hasAuthCookie = data.cookies.some(
        (c) =>
          (c.domain.includes("chatgpt.com") || c.domain.includes("openai.com")) &&
          (c.name === "oai-sc" || c.name.startsWith("__Secure-next-auth.session-token") || c.name === "accessToken") &&
          (c.expires === -1 || c.expires > now),
      );

      const hasUserStorage =
        Array.isArray(data.origins) &&
        data.origins.some(
          (o) =>
            o.origin.includes("chatgpt.com") &&
            Array.isArray(o.localStorage) &&
            o.localStorage.some((item) => item.name.startsWith("cache/user-") || item.name.includes("user-")),
        );

      return hasAuthCookie || hasUserStorage;
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
