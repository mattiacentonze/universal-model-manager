import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore, type StorageState } from "./session-store.js";
import { logger } from "../shared/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ChromeProfileItem {
  folder: string;
  name: string;
  email: string;
  gaiaName: string;
  hasSession: boolean;
}

export function getScriptPath(): string {
  const candidates = [
    resolve(__dirname, "../../scripts/extract-chrome-cookies.py"),
    resolve(__dirname, "../scripts/extract-chrome-cookies.py"),
    resolve(__dirname, "scripts/extract-chrome-cookies.py"),
    "/home/mcentonze1-iit.local/projects/universal-model-manager/scripts/extract-chrome-cookies.py",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

export function listChromeProfiles(): ChromeProfileItem[] {
  const script = getScriptPath();
  if (!existsSync(script)) return [];

  try {
    const raw = execFileSync("python3", [script, "--list"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!raw || !raw.trim()) return [];
    const parsed = JSON.parse(raw.trim());
    return Array.isArray(parsed.profiles) ? parsed.profiles : [];
  } catch (err) {
    logger.warn(`Could not list Chrome profiles: ${err}`);
    return [];
  }
}

export function importFromChromeProfile(profileFolder = "Default", sessionStore = new SessionStore()): { ok: boolean; profile?: ChromeProfileItem; error?: string } {
  const script = getScriptPath();
  if (!existsSync(script)) {
    return { ok: false, error: "Extractor script not found" };
  }

  // Find profile metadata
  const profiles = listChromeProfiles();
  const matched = profiles.find(
    p => p.folder.toLowerCase() === profileFolder.toLowerCase() ||
         p.name.toLowerCase() === profileFolder.toLowerCase() ||
         p.email.toLowerCase() === profileFolder.toLowerCase() ||
         (profileFolder === "iit" && p.email.includes("iit.it")) ||
         (profileFolder === "personal" && (p.email.includes("gmail") || p.folder === "Default"))
  );

  const targetFolder = matched ? matched.folder : profileFolder;

  try {
    const raw = execFileSync("python3", [script, targetFolder], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });

    if (!raw || !raw.trim()) return { ok: false, error: `No cookies returned for ${targetFolder}` };
    const parsed = JSON.parse(raw.trim()) as StorageState;
    if (!Array.isArray(parsed.cookies) || parsed.cookies.length === 0) {
      return { ok: false, error: `Profile ${targetFolder} has no cookies` };
    }

    sessionStore.save(parsed);

    const displayName = matched ? `${matched.name} (${matched.email || matched.folder})` : targetFolder;
    sessionStore.saveAccountInfo({
      name: displayName,
      email: matched?.email,
      updatedAt: new Date().toISOString(),
    });

    logger.info(`Successfully imported ChatGPT Web session from Chrome profile [${targetFolder}]: ${displayName}`);
    return { ok: true, profile: matched };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export function importFromDefaultChrome(sessionStore = new SessionStore()): boolean {
  return importFromChromeProfile("Default", sessionStore).ok;
}
