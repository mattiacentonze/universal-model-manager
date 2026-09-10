import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function getOpenCodeConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }
  const defaultDir = join(homedir(), ".config", "opencode");
  if (!existsSync(defaultDir)) {
    mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
  }
  return defaultDir;
}

export function getUniversalAuthDataDir(): string {
  if (process.env.OPENCODE_UNIVERSAL_AUTH_DIR) {
    return process.env.OPENCODE_UNIVERSAL_AUTH_DIR;
  }
  const dir = join(getOpenCodeConfigDir(), "universal-auth");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function getChatGptStorageStatePath(): string {
  return join(getUniversalAuthDataDir(), "chatgpt-storage-state.json");
}

export function getChatGptProfileDir(): string {
  const dir = join(getUniversalAuthDataDir(), "chatgpt-browser-profile");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function getBridgeDaemonInfoPath(): string {
  return join(getUniversalAuthDataDir(), "chatgpt-bridge-daemon.json");
}
