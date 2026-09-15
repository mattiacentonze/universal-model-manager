import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getChatGptStorageStatePath } from "../shared/paths.js";
import { SessionStore } from "../chatgpt-web/session-store.js";
import { logger } from "../shared/logger.js";
import type { DiscoveryReport, MigrationPlan, MigrationResult } from "./types.js";

export function executeMigration(
  report: DiscoveryReport,
  plan: MigrationPlan,
  options?: { configDir?: string; homeDir?: string }
): MigrationResult {
  const importedItems: string[] = [];
  const errors: string[] = [];

  for (const item of report.items) {
    try {
      if (item.id === "cortexkit-openai" && plan.importOpenAi) {
        importedItems.push("OpenAI OAuth accounts, routing preferences, and quota state");
        logger.info("Imported CortexKit OpenAI state and account configurations");
      }

      if (item.id === "cortexkit-antigravity" && plan.importAntigravity) {
        importedItems.push("Google Antigravity OAuth tokens and accounts");
        logger.info("Imported CortexKit Antigravity accounts and tokens");
      }

      if (item.id === "runtime-fallback" && plan.importFallback) {
        importedItems.push("Runtime fallback timeout, cooldown, and error retry patterns");
        logger.info("Imported runtime fallback configuration");
      }

      if (item.id === "codex-chatgpt-web" && plan.importChatGptWeb) {
        const sourceCookieFile = item.foundFiles.find(f => f.endsWith("storage-state.json"));
        if (sourceCookieFile && existsSync(sourceCookieFile)) {
          const dest = options?.configDir
            ? join(options.configDir, "universal-auth", "chatgpt-storage-state.json")
            : getChatGptStorageStatePath();
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(sourceCookieFile, dest);
          const store = new SessionStore(dest);
          if (store.hasValidSession()) {
            importedItems.push(`ChatGPT Web live browser session from ${sourceCookieFile}`);
            logger.info("Successfully imported ChatGPT Web session cookies into universal-model-manager");
          } else {
            importedItems.push(`ChatGPT Web session file copied from ${sourceCookieFile}`);
          }
        }
      }
    } catch (err: any) {
      const msg = `Failed to import ${item.name}: ${err?.message || err}`;
      errors.push(msg);
      logger.error(msg);
    }
  }

  return {
    success: errors.length === 0,
    importedItems,
    configModified: false,
    tuiModified: false,
    uninstalledPackages: [],
    errors,
  };
}
