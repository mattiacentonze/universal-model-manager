import { existsSync } from "node:fs";
import { join } from "node:path";
import { getOpenCodeConfigDir } from "../shared/paths.js";
import type { AccountProvider, ProviderAccount } from "./provider-accounts.js";
import {
  getAntigravityAccounts,
  getOpenAIAccounts,
  getOpenCodeZenAccounts,
  isOpencodeConfigured,
} from "./provider-accounts.js";
import type { AccountEntry, ProviderKind } from "./types.js";

/**
 * Real account status derived from the SANCTIONED provider stores, never from
 * `antigravity.json` (a settings file) or from a manually-toggled registry flag.
 *
 * Each `AccountEntry` maps 1:1 to a real provider account, so `main` reflects
 * the actual store (Antigravity `activeIndex`, OpenAI `mainAccountId`) and
 * `configured` is derived strictly from the presence of real credentials.
 */
export function realAccounts(kind: ProviderKind, configDir = getOpenCodeConfigDir()): ProviderAccount[] {
  if (kind === "openai") return getOpenAIAccounts(configDir);
  if (kind === "antigravity") return getAntigravityAccounts(configDir);
  if (kind === "opencode") return getOpenCodeZenAccounts(configDir);
  return [];
}

/**
 * Count real, credentialed accounts found in the underlying provider store for
 * a given provider. Returns 0 when the store is absent or empty.
 */
export function countRealAccounts(kind: ProviderKind, configDir = getOpenCodeConfigDir()): number {
  return realAccounts(kind, configDir).filter((a) => a.configured).length;
}

/**
 * Whether a provider has at least one real credentialed account at runtime.
 */
export function providerConfigured(kind: ProviderKind, configDir = getOpenCodeConfigDir()): boolean {
  if (kind === "chatgpt-web") {
    // ChatGPT web session is tracked separately by the bridge session store.
    const stateFile = join(getUniversalDataDir(configDir), "chatgpt-storage-state.json");
    return !!existsSync(stateFile);
  }
  if (kind === "opencode") {
    return isOpencodeConfigured(configDir);
  }
  return realAccounts(kind, configDir).some((a) => a.configured);
}

function getUniversalDataDir(configDir: string): string {
  if (process.env.OPENCODE_UNIVERSAL_AUTH_DIR) return process.env.OPENCODE_UNIVERSAL_AUTH_DIR;
  return join(configDir, "universal-auth");
}

function kindOf(provider: AccountProvider): ProviderKind {
  return provider;
}

/**
 * Reconcile the manager's account mirror against the real underlying stores for
 * the given providers, returning a fresh list ordered: real credentialed main
 * first, then other real accounts, then (only if no real account yet) a single
 * pending placeholder to guide the wizard. Never reports a fake main or a fake
 * `configured` status.
 */
export function reconcileConfigured(accounts: AccountEntry[], configDir = getOpenCodeConfigDir()): AccountEntry[] {
  const real = [
    ...realAccounts("openai", configDir),
    ...realAccounts("antigravity", configDir),
    ...realAccounts("opencode", configDir).filter((a) => a.configured),
  ];
  const webAccounts = accounts.filter((a) => a.kind === "chatgpt-web");
  // Preserve user-chosen aliases by matching on kind + label (stable real-store identity).
  const aliasByKey = new Map<string, string>();
  for (const a of accounts) {
    if (a.alias) aliasByKey.set(`${a.kind}:${a.label}`, a.alias);
  }
  const mirrored: AccountEntry[] = real.map((r) => {
    const kind = kindOf(r.provider);
    return {
      id: r.id,
      kind,
      label: r.label,
      alias: aliasByKey.get(`${kind}:${r.label}`),
      main: r.main,
      configured: r.configured,
    };
  });
  if (mirrored.length > 0) {
    // real credentialed mains first, then remaining real accounts, plus any web accounts.
    const sorted = mirrored.sort((a, b) => Number(b.configured && b.main) - Number(a.configured && a.main));
    return [...sorted, ...webAccounts];
  }
  return accounts;
}
