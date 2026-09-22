import { getOpenCodeConfigDir } from "../shared/paths.js";
import type { AccountProvider, ProviderAccount } from "./provider-accounts.js";
import { getOpenCodeZenAccounts } from "./provider-accounts.js";
import { getAdapter } from "./provider-adapter.js";
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
  if (kind === "opencode") return getOpenCodeZenAccounts(configDir);
  return getAdapter(kind).list(configDir);
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
  return getAdapter(kind).configured(configDir);
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
  // Preserve user-chosen aliases by the STABLE account id (not kind+label, which
  // is non-unique when two accounts share a label and caused removed aliases to
  // reappear after restart).
  const aliasById = new Map<string, string>();
  for (const a of accounts) {
    if (a.alias) aliasById.set(a.id, a.alias);
  }
  const mirrored: AccountEntry[] = real.map((r) => {
    const kind = kindOf(r.provider);
    const userAlias = aliasById.get(r.id);
    // Default alias = email when the account has one and no user alias is set.
    const alias = userAlias ?? (r.email ? r.email : undefined);
    return {
      id: r.id,
      kind,
      label: r.label,
      alias,
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
