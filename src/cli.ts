#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { setupOpenCodeConfig, findOpenCodeConfigFile } from "./shared/config-writer.js";
import { SessionStore } from "./chatgpt-web/session-store.js";
import { BrowserManager } from "./chatgpt-web/browser-manager.js";
import { getOrStartBridgeServer } from "./chatgpt-web/index.js";
import { getChatGptStorageStatePath, getOpenCodeConfigDir } from "./shared/paths.js";
import { logger } from "./shared/logger.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "status";

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(`
Universal Auth CLI for OpenCode

Usage:
  universal-auth status                     Display status of OpenAI OAuth, ChatGPT Web, and config
  universal-auth login chatgpt-web          Launch Chrome to log in to ChatGPT Web
  universal-auth setup                      Automatically add ChatGPT Web provider to opencode.jsonc
  universal-auth bridge [--port <number>]   Start the local ChatGPT Web bridge daemon
`);
    return;
  }

  if (command === "setup") {
    const res = setupOpenCodeConfig();
    if (res.modified) {
      console.log(`[Universal Auth] Successfully updated ${res.path} with ChatGPT Web provider & plugin!`);
    } else {
      console.log(`[Universal Auth] Configuration at ${res.path} is already up to date.`);
    }
    return;
  }

  if (command === "login") {
    const target = args[1];
    if (target === "chatgpt-web") {
      console.log("[Universal Auth] Launching Chrome for ChatGPT Web interactive login...");
      const sessionStore = new SessionStore();
      const manager = new BrowserManager(sessionStore);
      const success = await manager.launchInteractiveLogin();
      if (success) {
        console.log("[Universal Auth] Login captured successfully! Storage state saved to:", getChatGptStorageStatePath());
      } else {
        console.error("[Universal Auth] Login was not completed or failed.");
        process.exit(1);
      }
      return;
    }
    console.log("Usage: universal-auth login chatgpt-web");
    return;
  }

  if (command === "bridge") {
    const portArg = args.indexOf("--port");
    const port = portArg !== -1 && args[portArg + 1] ? Number(args[portArg + 1]) : 17842;
    console.log(`[Universal Auth] Starting ChatGPT Web bridge on http://127.0.0.1:${port}...`);
    await getOrStartBridgeServer(port);
    console.log(`[Universal Auth] Bridge running. Press Ctrl+C to stop.`);
    await new Promise(() => {}); // Keep alive
    return;
  }

  if (command === "status") {
    console.log("=== OpenCode Universal Auth Status ===");

    // 1. Config status
    const configFile = findOpenCodeConfigFile();
    const configExists = existsSync(configFile);
    console.log(`OpenCode Config: ${configFile} (${configExists ? "EXISTS" : "MISSING"})`);

    // 2. OpenAI OAuth status
    const openaiAuthFile = `${getOpenCodeConfigDir()}/openai-auth.json`;
    let openaiInfo = "Not configured";
    if (existsSync(openaiAuthFile)) {
      try {
        const parsed = JSON.parse(readFileSync(openaiAuthFile, "utf8"));
        openaiInfo = `Configured (type: ${parsed?.main?.type || "unknown"}, id: ${parsed?.mainAccountId || "none"})`;
      } catch {
        openaiInfo = "Corrupted auth file";
      }
    }
    console.log(`OpenAI OAuth: ${openaiInfo}`);

    // 3. ChatGPT Web session status
    const sessionStore = new SessionStore();
    const hasWebSession = sessionStore.hasValidSession();
    console.log(`ChatGPT Web Session: ${hasWebSession ? "LOGGED IN (Storage State Present)" : "NOT LOGGED IN"}`);
    console.log(`Storage State Path: ${getChatGptStorageStatePath()}`);

    // 4. Quick guidance
    if (!hasWebSession) {
      console.log("\nTo log in to ChatGPT Web, run:\n  universal-auth login chatgpt-web");
    }
    return;
  }

  console.error(`Unknown command: ${command}. Run 'universal-auth --help' for usage.`);
  process.exit(1);
}

main().catch(err => {
  logger.error("CLI error:", err);
  process.exit(1);
});
