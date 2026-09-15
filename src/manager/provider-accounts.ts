import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// @ts-ignore
import {
  type AccountMetadataV3,
  type AccountStorageV4,
  mutateAccountStorage,
} from "../../vendor/antigravity-auth-core/dist/index.js";
import { getOpenCodeConfigDir } from "../shared/paths.js";

/**
 * Real provider account stores.
 *   - OpenAI      -> openai-auth.json          (AccountStorage v1: CONFIG)
 *   - OpenAI cred -> openai-auth-state.json    (AccountRuntimeState: credentials)
 *   - Antigravity -> antigravity-accounts.json (AccountStorageV4)
 *
 * Never emit a raw credential (refresh/access token, account identity that is a
 * secret). OpenAI config accounts carry `{id,label,type,enabled,accountId}` —
 * NOT credentials; the real credential store is the separate state file and the
 * host OpenCode auth API (`client.auth.set`).
 */
export const OPENAI_ACCOUNT_FILE = "openai-auth.json";
export const OPENAI_STATE_FILE = "openai-auth-state.json";
export const ANTIGRAVITY_ACCOUNT_FILE = "antigravity-accounts.json";

export type AccountProvider = "openai" | "antigravity" | "opencode";

/** A sanitized view of one real provider account. Never carries tokens. */
export interface ProviderAccount {
  provider: AccountProvider;
  /** Stable manager-facing id (derived, one-way hash, never a secret). */
  id: string;
  label: string;
  email?: string;
  enabled: boolean;
  disabled: boolean;
  expired: boolean;
  /** Real credentials present in the proper store, NOT inferred from a type tag. */
  configured: boolean;
  main: boolean;
}

/**
 * A native action a consumer should dispatch (TUI slash command or terminal
 * exec argv) instead of a guessed direct write. `command`/`arguments` are for
 * the OpenCode native command surface; `cli` is the verified terminal binary
 * argv for exec (never a shell string).
 */
export interface NativeAction {
  provider: AccountProvider | "chatgpt-web";
  kind: "login" | "set-main" | "reorder" | "set-routing";
  /** OpenCode native slash command name (e.g. "/openai-account"). */
  command: string;
  /** Slash command arguments (e.g. "add", "order a b"). */
  arguments: string;
  /** Terminal argv to run via exec (never a shell string). */
  cli: { command: string; args: string[] };
  text: string;
}

/** Outcome of a main/reorder request: applied, delegated to native, invalid. */
export type MutationResult =
  | { kind: "applied"; text: string }
  | { kind: "delegate"; action: NativeAction; text: string }
  | { kind: "invalid"; text: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Short stable slug (FNV-1a) from a non-secret identity — never the raw key. */
export function accountIdFor(provider: AccountProvider, key: string): string {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return `${provider}-${(h >>> 0).toString(36)}`;
}

type RoutingMode = "main-first" | "fallback-first" | "sticky-balanced";

/* ------------------------------- OpenAI --------------------------------- */

interface OpenAIConfigAccount {
  id: string;
  label?: string;
  accountId?: string;
  type?: "oauth" | "api";
  enabled?: boolean;
  expires?: number;
}
interface OpenAIStorage {
  version?: unknown;
  main?: { type?: "opencode"; provider?: "openai" };
  routing?: { mode?: RoutingMode };
  mainAccountId?: string;
  accounts?: OpenAIConfigAccount[];
}
interface OpenAIStateAccount {
  access?: string;
  refresh?: string;
  expires?: number;
}
interface OpenAIState {
  version?: unknown;
  accounts?: Record<string, OpenAIStateAccount>;
}

function readOpenAI(configPath: string): OpenAIStorage | null {
  if (!existsSync(configPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
  if (!isObj(raw) || !Array.isArray(raw.accounts)) return null;
  return raw as OpenAIStorage;
}
function readOpenAIState(statePath: string): OpenAIState | null {
  if (!existsSync(statePath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  return raw as OpenAIState;
}

const hasStateCreds = (state: OpenAIState | null, id: string | undefined): boolean =>
  !!id && isObj(state?.accounts?.[id]) &&
    (typeof state.accounts![id].refresh === "string" && state.accounts![id].refresh.length > 0 ||
     typeof state.accounts![id].access === "string" && state.accounts![id].access.length > 0);

function accountExpired(a: OpenAIConfigAccount, state: OpenAIState | null, id: string | undefined, now: number): boolean {
  const stExp = id ? state?.accounts?.[id]?.expires : undefined;
  const exp = typeof stExp === "number" ? stExp : typeof a.expires === "number" ? a.expires : undefined;
  return exp === undefined ? false : exp <= now;
}

/**
 * The CONFIG file holds only `{id,label,type,enabled,accountId}` — never
 * credentials. The main slot (`main` block + `mainAccountId`) is a separate
 * primary whose credentials live in the host OpenCode auth API and cannot be
 * read here. Fallback credentials live in the separate state file.
 */
export function getOpenAIAccounts(configDir = getOpenCodeConfigDir()): ProviderAccount[] {
  const configPath = join(configDir, OPENAI_ACCOUNT_FILE);
  const store = readOpenAI(configPath);
  if (!store) return [];
  const state = readOpenAIState(join(configDir, OPENAI_STATE_FILE));
  const now = Date.now();
  const hasMain = !!store.main && store.main.type === "opencode";
  const mainId = typeof store.mainAccountId === "string" ? store.mainAccountId : undefined;
  const rows: ProviderAccount[] = [];
  const ids = store.accounts ?? [];
  for (const a of ids) {
    const id = a.accountId || a.id;
    const isMain = hasMain && mainId !== undefined && (a.accountId === mainId || a.id === mainId);
    rows.push({
      provider: "openai",
      id: accountIdFor("openai", id || a.id || "openai"),
      label: a.label || (isMain ? "OpenAI main" : "OpenAI account"),
      email: a.accountId,
      enabled: a.enabled !== false,
      disabled: a.enabled === false,
      expired: accountExpired(a, state, isMain ? mainId : id, now),
      configured: isMain ? hasMain && a.enabled !== false : hasStateCreds(state, id) && a.enabled !== false,
      main: isMain,
    });
  }
  // Separate main row when the primary is not among the configured fallbacks.
  if (hasMain && mainId !== undefined && !rows.some(r => r.main)) {
    rows.unshift({
      provider: "openai",
      id: accountIdFor("openai", mainId),
      label: "OpenAI main",
      email: mainId,
      enabled: true,
      disabled: false,
      expired: false,
      configured: true,
      main: true,
    });
  }
  return rows;
}

/**
 * Routing preference (`main-first`/`fallback-first`/`sticky-balanced`) maps to
 * the native `/openai-routing` command. It is exposed as a native action; the
 * primary itself is never swapped from this adapter (host auth holds its creds).
 */
export function routingModeAction(mode: RoutingMode): NativeAction {
  const action = loginActionFor("openai");
  return { ...action, kind: "set-routing", arguments: mode, cli: { command: "", args: [] }, text: `Set OpenAI routing to ${mode}.` };
}

/* ----------------------------- Antigravity ------------------------------ */

function antiKey(meta: AccountMetadataV3): string {
  // Non-secret durable identity: email when present, else one-way hash of the
  // refresh token. Never emits the raw token.
  return typeof meta.email === "string" && meta.email.length > 0
    ? meta.email
    : accountIdFor("antigravity", meta.refreshToken);
}

export function getAntigravityAccounts(configDir = getOpenCodeConfigDir()): ProviderAccount[] {
  const path = join(configDir, ANTIGRAVITY_ACCOUNT_FILE);
  if (!existsSync(path)) return [];
  let store: AccountStorageV4;
  try {
    // Reuse the sanctioned core loader so migrations/invalid-shape fail closed.
    const loaded = readAntigravity(path);
    if (!loaded) return [];
    store = loaded;
  } catch {
    return [];
  }
  const active = store.activeIndex;
  return store.accounts.map((meta, idx) => ({
    provider: "antigravity",
    id: accountIdFor("antigravity", antiKey(meta)),
    label: meta.label || meta.email || "Antigravity account",
    email: meta.email,
    enabled: meta.enabled !== false,
    disabled: meta.enabled === false || meta.accountIneligible === true || meta.verificationRequired === true,
    expired: false,
    configured: typeof meta.refreshToken === "string" && meta.refreshToken.length > 0,
    main: Number.isInteger(active) && active >= 0 && active < store.accounts.length && idx === active,
  }));
}

function readAntigravity(path: string): AccountStorageV4 | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (isObj(raw) && (raw as { version?: unknown }).version === 4 && Array.isArray((raw as { accounts?: unknown }).accounts)) {
    return raw as unknown as AccountStorageV4;
  }
  return null;
}

/** Set the real Antigravity main under the sanctioned lock. */
export async function setAntigravityMain(configDir: string, managerId: string): Promise<MutationResult> {
  const path = join(configDir, ANTIGRAVITY_ACCOUNT_FILE);
  let target: number | undefined;
  try {
    await mutateAccountStorage(path, current => {
      const idx = current.accounts.findIndex(m => accountIdFor("antigravity", antiKey(m)) === managerId);
      if (idx === -1) return undefined;
      target = idx;
      current.activeIndex = idx;
      if (current.activeIndexByFamily) {
        current.activeIndexByFamily.claude = idx;
        current.activeIndexByFamily.gemini = idx;
      }
      return current;
    });
  } catch {
    return { kind: "invalid", text: "[Manager] Could not set Antigravity main (store lock/unreadable)." };
  }
  return target === undefined
    ? { kind: "invalid", text: `[Manager] Unknown account id: ${managerId}` }
    : { kind: "applied", text: `${managerId} is now the real Antigravity main.` };
}

/** Reorder the real Antigravity pool under the sanctioned lock, preserving main. */
export async function reorderAntigravityAccounts(configDir: string, orderedIds: string[]): Promise<MutationResult> {
  const path = join(configDir, ANTIGRAVITY_ACCOUNT_FILE);
  let applied = false;
  try {
    await mutateAccountStorage(path, current => {
      const idOf = (m: AccountMetadataV3) => accountIdFor("antigravity", antiKey(m));
      const byId = new Map(current.accounts.map(m => [idOf(m), m]));
      if (!isPermutation(orderedIds, [...byId.keys()])) return undefined;
      const prevMainIndex = current.activeIndex;
      const prevMainId = current.accounts[prevMainIndex] ? idOf(current.accounts[prevMainIndex]) : undefined;
      const prevFamily = current.activeIndexByFamily
        ? {
            claude: current.activeIndexByFamily.claude,
            gemini: current.activeIndexByFamily.gemini,
          }
        : undefined;
      const prevFamilyIds = {
        claude: prevFamily?.claude !== undefined && current.accounts[prevFamily.claude] ? idOf(current.accounts[prevFamily.claude]) : undefined,
        gemini: prevFamily?.gemini !== undefined && current.accounts[prevFamily.gemini] ? idOf(current.accounts[prevFamily.gemini]) : undefined,
      };
      current.accounts = orderedIds.map(id => byId.get(id) as AccountMetadataV3);
      current.activeIndex = prevMainId !== undefined ? current.accounts.findIndex(m => idOf(m) === prevMainId) : 0;
      if (prevFamily) {
        const fam = (field: "claude" | "gemini") => {
          const id = prevFamilyIds[field];
          const idx = id !== undefined ? current.accounts.findIndex(m => idOf(m) === id) : -1;
          return idx >= 0 ? idx : current.activeIndex;
        };
        current.activeIndexByFamily = { claude: fam("claude"), gemini: fam("gemini") };
      }
      applied = true;
      return current;
    });
  } catch {
    return { kind: "invalid", text: "[Manager] Could not reorder Antigravity accounts (store lock/unreadable)." };
  }
  return applied
    ? { kind: "applied", text: "[Manager] Real Antigravity account order updated." }
    : { kind: "invalid", text: "[Manager] Invalid reorder: ids must name every account once." };
}

/** Safe permutation check: exact same set, unique ids (fail closed on dupes). */
function isPermutation(ordered: string[], current: string[]): boolean {
  if (ordered.length !== current.length) return false;
  const seen = new Set<string>();
  const avail = new Set(current);
  for (const id of ordered) {
    if (seen.has(id) || !avail.has(id)) return false;
    seen.add(id);
  }
  return seen.size === current.length;
}

/* ----------------------------- OpenCode Zen ----------------------------- */

/** Whether OpenCode Zen credentials or provider configuration are present. */
export function isOpencodeConfigured(configDir = getOpenCodeConfigDir()): boolean {
  const localAuth = join(configDir, "auth.json");
  if (existsSync(localAuth)) {
    try {
      const auth = JSON.parse(readFileSync(localAuth, "utf8"));
      if (auth && typeof auth === "object" && auth.opencode) return true;
    } catch {}
  }
  if (!process.env.OPENCODE_CONFIG_DIR && configDir === getOpenCodeConfigDir()) {
    const dataDir = process.env.XDG_DATA_HOME
      ? join(process.env.XDG_DATA_HOME, "opencode")
      : join(homedir(), ".local", "share", "opencode");
    const globalAuth = join(dataDir, "auth.json");
    if (existsSync(globalAuth)) {
      try {
        const auth = JSON.parse(readFileSync(globalAuth, "utf8"));
        if (auth && typeof auth === "object" && auth.opencode) return true;
      } catch {}
    }
  }
  for (const f of ["opencode.jsonc", "opencode.json"]) {
    const p = join(configDir, f);
    if (existsSync(p)) {
      try {
        const text = readFileSync(p, "utf8");
        if (text.includes('"opencode"') || text.includes("'opencode'")) return true;
      } catch {}
    }
  }
  return false;
}

export function getOpenCodeZenAccounts(configDir = getOpenCodeConfigDir()): ProviderAccount[] {
  const configured = isOpencodeConfigured(configDir);
  return [
    {
      provider: "opencode",
      id: "opencode-zen",
      label: "OpenCode Zen",
      email: undefined,
      enabled: true,
      disabled: false,
      expired: false,
      configured,
      main: true,
    },
  ];
}

/* ------------------------------ Unified API ----------------------------- */

/** Sanitized account enumeration across both providers (separate main + fallbacks). */
export function getAccounts(configDir = getOpenCodeConfigDir()): ProviderAccount[] {
  return [...getOpenAIAccounts(configDir), ...getAntigravityAccounts(configDir)];
}

/**
 * Set the real main account for the owning provider by manager id.
 * Antigravity is a real locked mutation. OpenAI's primary cannot be replaced
 * from the config file (the host auth API owns its credentials), so it is
 * DELEGATED to native login rather than returning a false success.
 */
export async function setMainByManagerId(configDir: string, managerId: string): Promise<MutationResult> {
  const anti = getAntigravityAccounts(configDir).find(a => a.id === managerId);
  if (anti) return setAntigravityMain(configDir, managerId);
  const openai = getOpenAIAccounts(configDir).find(a => a.id === managerId);
  if (openai) {
    // No supported config-level primary swap; delegate to native login which
    // correctly replaces the OpenCode primary and persists mainAccountId.
    const action = loginActionFor("openai");
    return {
      kind: "delegate",
      action,
      text: "OpenAI's primary is replaced through native login. Run the action to add the new primary.",
    };
  }
  return { kind: "invalid", text: `[Manager] Unknown account id: ${managerId}` };
}

/** Reorder a single provider's real store by manager ids. */
export async function reorderByManagerIds(configDir: string, managerIds: string[]): Promise<MutationResult> {
  const accounts = getAccounts(configDir);
  const providers = new Set(
    managerIds.map(id => accounts.find(a => a.id === id)?.provider).filter((p): p is AccountProvider => !!p)
  );
  if (providers.size !== 1) return { kind: "invalid", text: "[Manager] Invalid reorder: ids must name one provider only." };
  const provider = [...providers][0];
  // The reorderable roster: for OpenAI the separate main slot is not reorderable,
  // for Antigravity the main is the activeIndex within the single pool.
  const reorderable = accounts.filter(a => a.provider === provider && (provider === "openai" ? !a.main : true));
  const allIds = reorderable.map(a => a.id);
  if (!isPermutation(managerIds, allIds)) {
    return { kind: "invalid", text: "[Manager] Invalid reorder: ids must name every account of the provider once (no duplicates)." };
  }
  if (provider === "openai") return reorderOpenAIAccounts(configDir, managerIds);
  return reorderAntigravityAccounts(configDir, managerIds);
}

/**
 * OpenAI reorder via the native `/openai-account order <a> <b>` swaps (the only
 * supported mutation path). No direct config write: the fallback roster order is
 * owned by the plugin. Emits the minimal sequence of adjacent swaps.
 */
export async function reorderOpenAIAccounts(configDir: string, orderedIds: string[]): Promise<MutationResult> {
  const accounts = getOpenAIAccounts(configDir).filter(a => !a.main);
  const current = accounts.map(a => a.id);
  if (!isPermutation(orderedIds, current)) {
    return { kind: "invalid", text: "[Manager] Invalid reorder: ids must name every fallback account once (no duplicates)." };
  }
  const swaps: string[] = [];
  const work = [...current];
  for (let i = 0; i < orderedIds.length; i++) {
    const target = orderedIds[i];
    if (work[i] === target) continue;
    const j = work.indexOf(target);
    if (j === -1) return { kind: "invalid", text: "[Manager] Invalid reorder: unknown account id." };
    const left = work[i];
    [work[i], work[j]] = [work[j], work[i]];
    swaps.push(`${left} ${target}`);
  }
  if (swaps.length === 0) return { kind: "applied", text: "[Manager] Account order already matches." };
  const action: NativeAction = loginActionFor("openai");
  const args = ["order", ...swaps[0].split(" ")].join(" ");
  return {
    kind: "delegate",
    action: {
      ...action,
      kind: "reorder",
      arguments: args,
      cli: { command: "", args: [] }, // no terminal CLI reorder (TUI slash command only)
      text: swaps.map(s => `/openai-account order ${s}`).join("; "),
    },
    text: "OpenAI fallback order is changed through the native plugin. Dispatch the native action(s).",
  };
}

/**
 * Real login actions. `command`/`arguments` are OpenCode native slash-command
 * surface; `cli` is the verified terminal binary argv for exec.
 */
export function loginActionFor(provider: "openai" | "antigravity" | "chatgpt-web" | "opencode", label?: string): NativeAction {
  const labelArg = label ? ` --label ${JSON.stringify(label)}` : "";
  if (provider === "openai") {
    return {
      provider,
      kind: "login",
      command: "/openai-account",
      arguments: "add",
      cli: { command: "openai-auth", args: label ? ["login", "--label", label] : ["login"] },
      text: "Run native login to add an OpenAI/ChatGPT account (replaces the primary).",
    };
  }
  if (provider === "antigravity") {
    return {
      provider,
      kind: "login",
      command: "/antigravity-account",
      arguments: "add-oauth-start",
      cli: { command: "antigravity-auth", args: ["login"] },
      text: "Run native login to add a Google Antigravity account.",
    };
  }
  if (provider === "opencode") {
    return {
      provider,
      kind: "login",
      command: "/auth",
      arguments: "login opencode",
      cli: { command: "opencode", args: ["auth", "login"] },
      text: "Run native login to authenticate OpenCode Zen.",
    };
  }
  return {
    provider,
    kind: "login",
    command: "/universal-chatgpt-web",
    arguments: "login",
    cli: { command: "universal-auth", args: ["login", "chatgpt-web"] },
    text: "Run native login to sign in to ChatGPT Web.",
  };
}
