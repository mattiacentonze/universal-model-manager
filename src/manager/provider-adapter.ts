import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MutationResult, NativeAction, ProviderAccount } from "./provider-accounts.js";
import {
  getAntigravityAccounts,
  getOpenAIAccounts,
  isOpencodeConfigured,
  reorderAntigravityAccounts,
  reorderOpenAIAccounts,
  setAntigravityMain,
} from "./provider-accounts.js";
import type { ProviderKind } from "./types.js";

/**
 * A generic provider adapter. Every provider shares the same account-list,
 * priority (main), reorder, login and configured semantics so callers never
 * branch per provider.
 */
export interface ProviderAdapter {
  kind: ProviderKind;
  displayName: string;
  /** Enumerate real accounts for this provider. */
  list(configDir: string): ProviderAccount[];
  /** Set the main account by manager id. */
  setMain(configDir: string, managerId: string): Promise<MutationResult>;
  /** Reorder this provider's accounts by manager ids. */
  reorder(configDir: string, orderedIds: string[]): Promise<MutationResult>;
  /** Native login action to add a new account. */
  loginAction(label?: string): NativeAction;
  /** Whether the provider has at least one real credentialed account. */
  configured(configDir: string): boolean;
}

function getUniversalDataDir(configDir: string): string {
  if (process.env.OPENCODE_UNIVERSAL_AUTH_DIR) return process.env.OPENCODE_UNIVERSAL_AUTH_DIR;
  return join(configDir, "universal-auth");
}

function openaiLogin(label?: string): NativeAction {
  return {
    provider: "openai",
    kind: "login",
    command: "/openai-account",
    arguments: "add",
    cli: { command: "openai-auth", args: label ? ["login", "--label", label] : ["login"] },
    text: "Run native login to add an OpenAI/ChatGPT account (replaces the primary).",
  };
}

function antigravityLogin(): NativeAction {
  return {
    provider: "antigravity",
    kind: "login",
    command: "/google-account",
    arguments: "add-oauth-start",
    cli: { command: "antigravity-auth", args: ["login"] },
    text: "Run native login to add a Google Antigravity account.",
  };
}

function opencodeLogin(): NativeAction {
  return {
    provider: "opencode",
    kind: "login",
    command: "/auth",
    arguments: "login opencode",
    cli: { command: "opencode", args: ["auth", "login"] },
    text: "Run native login to authenticate OpenCode Zen.",
  };
}

function chatgptWebLogin(): NativeAction {
  return {
    provider: "chatgpt-web",
    kind: "login",
    command: "/universal-chatgpt-web",
    arguments: "login",
    cli: { command: "universal-auth", args: ["login", "chatgpt-web"] },
    text: "Run native login to sign in to ChatGPT Web.",
  };
}

const openaiAdapter: ProviderAdapter = {
  kind: "openai",
  displayName: "OpenAI",
  list: (configDir) => getOpenAIAccounts(configDir),
  setMain: async () => ({
    kind: "delegate",
    action: openaiLogin(),
    text: "OpenAI's primary is replaced through native login. Run the action to add the new primary.",
  }),
  reorder: (configDir, orderedIds) => reorderOpenAIAccounts(configDir, orderedIds),
  loginAction: (label) => openaiLogin(label),
  configured: (configDir) => getOpenAIAccounts(configDir).some((a) => a.configured),
};

const antigravityAdapter: ProviderAdapter = {
  kind: "antigravity",
  displayName: "Google Antigravity",
  list: (configDir) => getAntigravityAccounts(configDir),
  setMain: (configDir, managerId) => setAntigravityMain(configDir, managerId),
  reorder: (configDir, orderedIds) => reorderAntigravityAccounts(configDir, orderedIds),
  loginAction: () => antigravityLogin(),
  configured: (configDir) => getAntigravityAccounts(configDir).some((a) => a.configured),
};

const opencodeAdapter: ProviderAdapter = {
  kind: "opencode",
  displayName: "OpenCode Zen",
  list: () => [],
  setMain: async () => ({ kind: "invalid", text: "[Manager] OpenCode Zen has no main account to set." }),
  reorder: async () => ({ kind: "invalid", text: "[Manager] OpenCode Zen has no account order to reorder." }),
  loginAction: () => opencodeLogin(),
  configured: (configDir) => isOpencodeConfigured(configDir),
};

const chatgptWebAdapter: ProviderAdapter = {
  kind: "chatgpt-web",
  displayName: "ChatGPT Web",
  list: () => [],
  setMain: async () => ({ kind: "invalid", text: "[Manager] ChatGPT Web has no main account to set." }),
  reorder: async () => ({ kind: "invalid", text: "[Manager] ChatGPT Web has no account order to reorder." }),
  loginAction: () => chatgptWebLogin(),
  configured: (configDir) => existsSync(join(getUniversalDataDir(configDir), "chatgpt-storage-state.json")),
};

/** Registry mapping every provider kind to its adapter. */
export const PROVIDER_ADAPTERS: Record<ProviderKind, ProviderAdapter> = {
  openai: openaiAdapter,
  antigravity: antigravityAdapter,
  "chatgpt-web": chatgptWebAdapter,
  opencode: opencodeAdapter,
};

export function getAdapter(kind: ProviderKind): ProviderAdapter {
  return PROVIDER_ADAPTERS[kind];
}

export function allAdapters(): ProviderAdapter[] {
  return Object.values(PROVIDER_ADAPTERS);
}
