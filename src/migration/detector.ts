import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { getOpenCodeConfigDir } from "../shared/paths.js";
import type { DiscoveredLegacyItem, DiscoveryReport } from "./types.js";

export function detectLegacyPluginsAndConfigs(options: {
  configDir?: string;
  homeDir?: string;
} = {}): DiscoveryReport {
  const configDir = options.configDir || getOpenCodeConfigDir();
  const home = options.homeDir || homedir();
  const items: DiscoveredLegacyItem[] = [];

  // Read active opencode.jsonc / opencode.json
  let activePlugins: string[] = [];
  const configFiles = [join(configDir, "opencode.jsonc"), join(configDir, "opencode.json")];
  for (const cf of configFiles) {
    if (existsSync(cf)) {
      try {
        const parsed = parse(readFileSync(cf, "utf8")) || {};
        if (Array.isArray(parsed.plugin)) {
          activePlugins = parsed.plugin.map((p: unknown) => (typeof p === "string" ? p : ""));
        }
      } catch {
        // Ignored
      }
      break;
    }
  }

  // 1. CortexKit OpenAI Auth
  const openAiFiles: string[] = [];
  const openAiSecrets: string[] = [];
  const openAiDetails: Record<string, unknown> = {};

  const openAiAuthJson = join(configDir, "openai-auth.json");
  if (existsSync(openAiAuthJson)) {
    openAiFiles.push(openAiAuthJson);
    try {
      const data = JSON.parse(readFileSync(openAiAuthJson, "utf8"));
      openAiDetails.mainAccountId = data?.mainAccountId || null;
      openAiDetails.accountsCount = Array.isArray(data?.accounts) ? data.accounts.length : 0;
      openAiDetails.routing = data?.routing || "default";
    } catch {}
  }

  const openAiStateJson = join(configDir, "openai-auth-state.json");
  if (existsSync(openAiStateJson)) {
    openAiFiles.push(openAiStateJson);
    openAiSecrets.push("OAuth tokens & refresh leases (openai-auth-state.json)");
  }

  const openAiFoundInConfig = activePlugins.some(p => p.includes("opencode-openai-auth"));
  if (openAiFoundInConfig || openAiFiles.length > 0) {
    items.push({
      id: "cortexkit-openai",
      name: "CortexKit OpenAI Auth",
      description: "OAuth credentials and multi-account quota tracking for ChatGPT Plus/Pro",
      foundInConfig: openAiFoundInConfig,
      foundFiles: openAiFiles,
      secretsDetected: openAiSecrets,
      details: openAiDetails,
    });
  }

  // 2. CortexKit Antigravity Auth
  const antigravityFiles: string[] = [];
  const antigravitySecrets: string[] = [];
  const antigravityDetails: Record<string, unknown> = {};

  const antigravityJson = join(configDir, "antigravity.json");
  if (existsSync(antigravityJson)) {
    antigravityFiles.push(antigravityJson);
  }

  const antigravityAccountsJson = join(configDir, "antigravity-accounts.json");
  if (existsSync(antigravityAccountsJson)) {
    antigravityFiles.push(antigravityAccountsJson);
    antigravitySecrets.push("Google OAuth tokens & account secrets (antigravity-accounts.json)");
    try {
      const data = JSON.parse(readFileSync(antigravityAccountsJson, "utf8"));
      const accounts = Array.isArray(data) ? data : data?.accounts || [];
      antigravityDetails.accountsCount = accounts.length;
    } catch {}
  }

  const antigravityFoundInConfig = activePlugins.some(p => p.includes("opencode-antigravity-auth"));
  if (antigravityFoundInConfig || antigravityFiles.length > 0) {
    items.push({
      id: "cortexkit-antigravity",
      name: "CortexKit Antigravity Auth",
      description: "Google Antigravity OAuth tokens and signature cache for Gemini 3 / Claude",
      foundInConfig: antigravityFoundInConfig,
      foundFiles: antigravityFiles,
      secretsDetected: antigravitySecrets,
      details: antigravityDetails,
    });
  }

  // 3. Runtime Fallback Plugin
  const fallbackFiles: string[] = [];
  const fallbackDetails: Record<string, unknown> = {};

  const fallbackJson = join(configDir, "opencode-fallback.json");
  const fallbackJsonc = join(configDir, "opencode-fallback.jsonc");
  const activeFallbackFile = existsSync(fallbackJsonc) ? fallbackJsonc : existsSync(fallbackJson) ? fallbackJson : null;

  if (activeFallbackFile) {
    fallbackFiles.push(activeFallbackFile);
    try {
      const data = parse(readFileSync(activeFallbackFile, "utf8"));
      fallbackDetails.cooldownSeconds = data?.cooldown_seconds;
      fallbackDetails.retryOnErrors = data?.retry_on_errors;
      fallbackDetails.timeoutSeconds = data?.timeout_seconds;
    } catch {}
  }

  const fallbackFoundInConfig = activePlugins.some(p => p.includes("opencode-runtime-fallback"));
  if (fallbackFoundInConfig || fallbackFiles.length > 0) {
    items.push({
      id: "runtime-fallback",
      name: "OpenCode Runtime Fallback",
      description: "Automatic fallback configuration and retry rules for model failures",
      foundInConfig: fallbackFoundInConfig,
      foundFiles: fallbackFiles,
      secretsDetected: [],
      details: fallbackDetails,
    });
  }

  // 4. Codex ChatGPT Web
  const webFiles: string[] = [];
  const webSecrets: string[] = [];
  const webDetails: Record<string, unknown> = {};

  const codexWebPaths = [
    process.env.CODEX_CHATGPT_WEB_HOME,
    join(home, ".codex-chatgpt-web"),
    join(home, ".codex-chatgpt-web-dev"),
    join(home, ".config", "codex-chatgpt-web"),
  ].filter(Boolean) as string[];

  for (const basePath of codexWebPaths) {
    if (existsSync(basePath)) {
      const storageState = join(basePath, "storage-state.json");
      if (existsSync(storageState)) {
        webFiles.push(storageState);
        webSecrets.push(`ChatGPT Web session cookies (${storageState})`);
      }
      const runtimeStorage = join(basePath, "runtime", "storage-state.json");
      if (existsSync(runtimeStorage)) {
        webFiles.push(runtimeStorage);
        webSecrets.push(`ChatGPT Web runtime session cookies (${runtimeStorage})`);
      }
      const cfg = join(basePath, "config.json");
      if (existsSync(cfg)) {
        webFiles.push(cfg);
        try {
          const data = JSON.parse(readFileSync(cfg, "utf8"));
          webDetails.mode = data?.mode;
          webDetails.proAvailable = data?.proAvailable;
          webDetails.solAvailable = data?.solAvailable;
        } catch {}
      }
    }
  }

  if (webFiles.length > 0) {
    items.push({
      id: "codex-chatgpt-web",
      name: "Codex ChatGPT Web",
      description: "Live ChatGPT Web browser profile, cookies, and capabilities",
      foundInConfig: false,
      foundFiles: webFiles,
      secretsDetected: webSecrets,
      details: webDetails,
    });
  }

  // Check for potential conflicts
  const conflicts: string[] = [];
  if (openAiFoundInConfig) {
    conflicts.push("@cortexkit/opencode-openai-auth conflicts with universal-model-manager on OpenAI OAuth intercepts");
  }
  if (antigravityFoundInConfig) {
    conflicts.push("@cortexkit/opencode-antigravity-auth conflicts with universal-model-manager on Google/Antigravity OAuth hooks");
  }
  if (fallbackFoundInConfig) {
    conflicts.push("opencode-runtime-fallback conflicts with universal-model-manager on duplicate error replay cycles");
  }

  return {
    timestamp: new Date().toISOString(),
    items,
    hasConflictsWithUniversalManager: conflicts.length > 0,
    conflictSummary: conflicts,
  };
}
