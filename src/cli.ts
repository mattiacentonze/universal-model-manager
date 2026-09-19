#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserManager } from "./chatgpt-web/browser-manager.js";
import { getOrStartBridgeServer } from "./chatgpt-web/index.js";
import { SessionStore } from "./chatgpt-web/session-store.js";
import { completeStep, currentStep, firstMissingStep, loadConfig, resetManager } from "./manager/index.js";
import { loginActionFor, reorderByManagerIds, setMainByManagerId } from "./manager/provider-accounts.js";
import { detectLegacyPluginsAndConfigs, formatDiscoveryReport, runInteractiveMigration } from "./migration/index.js";
import { findOpenCodeConfigFile, removeUniversalConfig, setupOpenCodeConfig } from "./shared/config-writer.js";
import { PLUGIN_ALIASES, PLUGIN_ID } from "./shared/constants.js";
import { logger } from "./shared/logger.js";
import { getChatGptStorageStatePath, getOpenCodeConfigDir } from "./shared/paths.js";

/** This checkout root, inferred from the CLI module location (src/cli.ts or dist/cli.js). */
function inferLocalRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function printAccountSummary() {
  const cfg = loadConfig();
  console.log("Accounts:");
  for (const a of cfg.accounts) {
    console.log(
      `  - ${a.id} [${a.kind}]${a.main ? " (main)" : ""}: ${a.label} — ${a.configured ? "ready" : "pending"}`,
    );
  }
  console.log(`Router orchestrator: ${cfg.router.orchestrator} (${cfg.router.enabled ? "enabled" : "disabled"})`);
  for (const t of ["fast", "medium", "heavy"] as const) {
    const c = cfg.router.tiers[t];
    console.log(`  ${t}: ${c.model}${c.variant ? ` (${c.variant})` : ""} -> ${c.fallback.join(", ") || "-"}`);
  }
  const next = firstMissingStep(cfg);
  console.log(`Wizard: ${next === null ? "complete" : `resume at ${next}`}`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "status";

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(`
Universal Model Manager CLI for OpenCode (${PLUGIN_ID})

Usage:
  universal-model-manager status                  Show provider + manager + wizard status
  universal-model-manager scan                    Scan for legacy plugins, secrets, and configs
  universal-model-manager migrate [--yes] [--uninstall] [--dry-run]
                                                  Interactive migration: import secrets/config and replace legacy plugins
  universal-model-manager wizard                  Show current missing wizard step
  universal-model-manager accounts                List/add/reorder provider accounts
  universal-model-manager router [set ...]        Show or change router + per-tier chains
  universal-model-manager reset                   Reset manager config & wizard (keeps credentials)
  universal-model-manager install [--backup]      Insert plugin + tui entries
  universal-model-manager setup                   Alias for install
  universal-model-manager uninstall [--backup]    Remove managed plugin + provider entries
  universal-model-manager login chatgpt-web       Launch Chrome to log in to ChatGPT Web
  universal-model-manager bridge [--port <n>]     Start the local ChatGPT Web bridge daemon
`);
    return;
  }

  if (command === "install" || command === "setup") {
    const backup = args.includes("--backup");
    const localIdx = args.indexOf("--local");
    const local = localIdx !== -1 && args[localIdx + 1] ? args[localIdx + 1] : inferLocalRoot();
    const res = setupOpenCodeConfig({ backup, localPluginPath: local });
    if (res.modified) {
      console.log(
        `[Manager] Updated ${res.path} (local package ${local}) + chatgpt-web provider${backup ? " (backup written)" : ""}.`,
      );
    } else {
      console.log(`[Manager] ${res.path} is already up to date (aliases: ${PLUGIN_ALIASES.join(", ")}).`);
    }
    return;
  }

  if (command === "uninstall") {
    const backup = args.includes("--backup");
    const res = removeUniversalConfig({ backup, localPluginPath: inferLocalRoot() });
    if (res.modified) {
      console.log(
        `[Manager] Removed ${PLUGIN_ID} (+ antigravity) + chatgpt-web provider from ${res.path}${backup ? " (backup written)" : ""}.`,
      );
    } else {
      console.log(`[Manager] ${res.path} had no managed entries to remove.`);
    }
    return;
  }

  if (command === "scan") {
    const report = detectLegacyPluginsAndConfigs();
    console.log(formatDiscoveryReport(report));
    return;
  }

  if (command === "migrate") {
    const autoConfirm = args.includes("--yes") || args.includes("-y");
    const dryRun = args.includes("--dry-run");
    const uninstallNpm = args.includes("--uninstall");
    await runInteractiveMigration({ autoConfirm, dryRun, uninstallNpm });
    return;
  }

  if (command === "reset") {
    const proceed = process.env.UNIVERSAL_AUTH_CONFIRM_RESET === "1";
    if (!proceed) {
      console.error(
        "[Manager] Refusing to reset without confirmation. Set UNIVERSAL_AUTH_CONFIRM_RESET=1 to proceed. Credentials are never touched by reset.",
      );
      process.exit(1);
    }
    const cfg = resetManager();
    console.log(
      `[Manager] Manager config & wizard reset. Config written to ${getOpenCodeConfigDir()}/universal-auth/manager.json. Credentials untouched.`,
    );
    void cfg;
    return;
  }

  if (command === "wizard") {
    const step = currentStep();
    console.log(step === null ? "[Manager] Wizard complete." : `[Manager] Next missing step: ${step}`);
    return;
  }

  if (command === "accounts") {
    const sub = args[1];
    if (sub === "add") {
      const kind = args[2];
      if (!kind || !["openai", "antigravity", "chatgpt-web"].includes(kind)) {
        console.error("Usage: universal-auth accounts add <openai|antigravity|chatgpt-web> [label]");
        process.exit(1);
      }
      const action = loginActionFor(kind as any);
      console.log(`[Manager] Running native login: ${action.text}`);
      execFileSync(action.cli.command, action.cli.args, { stdio: "inherit" });
      return;
    }
    if (sub === "reorder") {
      const order = args.slice(2);
      if (order.length === 0) {
        console.error("Usage: universal-auth accounts reorder <id> [id...]");
        process.exit(1);
      }
      const res = await reorderByManagerIds(getOpenCodeConfigDir(), order);
      if (res.kind === "invalid") {
        console.error(res.text);
        process.exit(1);
      }
      if (res.kind === "delegate") {
        console.log(`[Manager] Delegate to native: ${res.action.text}`);
        process.exit(0);
      }
      console.log(res.text);
      return;
    }
    if (sub === "main") {
      const id = args[2];
      if (!id) {
        console.error("Usage: universal-auth accounts main <account-id>");
        process.exit(1);
      }
      const res = await setMainByManagerId(getOpenCodeConfigDir(), id);
      if (res.kind === "invalid") {
        console.error(res.text);
        process.exit(1);
      }
      if (res.kind === "delegate") {
        console.log(`[Manager] OpenAI primary is replaced via native login.`);
        process.exit(0);
      }
      console.log(res.text);
      return;
    }
    printAccountSummary();
    return;
  }

  if (command === "router") {
    const _cfg = loadConfig();
    const setIdx = args.indexOf("set");
    if (setIdx !== -1) {
      const tier = args[setIdx + 1];
      const model = args[setIdx + 2];
      if (!["fast", "medium", "heavy"].includes(tier || "") || !model) {
        console.error("Usage: universal-auth router set <fast|medium|heavy> <model> [variant] [fallback,...]");
        process.exit(1);
      }
      const variant = args[setIdx + 3];
      const fallback = (args[setIdx + 4] || "").split(",").filter(Boolean);
      const res = completeStep("tiers", { [tier]: { model, variant, fallback } } as any);
      void res;
      console.log(
        `[Manager] ${tier} chain set to ${model}${variant ? ` (${variant})` : ""} -> ${fallback.join(", ")}.`,
      );
      return;
    }
    printAccountSummary();
    return;
  }

  if (command === "login") {
    const target = args[1];
    if (target === "chatgpt-web") {
      console.log("[Manager] Launching Chrome for ChatGPT Web interactive login...");
      const sessionStore = new SessionStore();
      const manager = new BrowserManager(sessionStore);
      const success = await manager.launchInteractiveLogin();
      if (success) {
        console.log("[Manager] Login captured successfully! Storage state saved to:", getChatGptStorageStatePath());
      } else {
        console.error("[Manager] Login was not completed or failed.");
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
    console.log(`[Manager] Starting ChatGPT Web bridge on http://127.0.0.1:${port}...`);
    await getOrStartBridgeServer(port);
    console.log(`[Manager] Bridge running. Press Ctrl+C to stop.`);
    await new Promise(() => {});
    return;
  }

  if (command === "status") {
    console.log(`=== Unified Model Manager (${PLUGIN_ID}) ===`);
    const configFile = findOpenCodeConfigFile();
    console.log(`OpenCode Config: ${configFile} (${existsSync(configFile) ? "EXISTS" : "MISSING"})`);
    const cfg = loadConfig();
    for (const a of cfg.accounts) {
      console.log(`  ${a.id} [${a.kind}]${a.main ? " (main)" : ""}: ${a.configured ? "ready" : "pending"}`);
    }
    for (const t of ["fast", "medium", "heavy"] as const) {
      const c = cfg.router.tiers[t];
      console.log(`  ${t}: ${c.model}${c.variant ? ` (${c.variant})` : ""} -> ${c.fallback.join(", ") || "-"}`);
    }
    const next = firstMissingStep(cfg);
    console.log(`Wizard: ${next === null ? "complete" : `resume at ${next}`}`);
    const sessionStore = new SessionStore();
    console.log(`ChatGPT Web: ${sessionStore.hasValidSession() ? "LOGGED IN" : "NOT LOGGED IN"}`);
    return;
  }

  console.error(`Unknown command: ${command}. Run 'universal-auth --help' for usage.`);
  process.exit(1);
}

main().catch((err) => {
  logger.error("CLI error:", err);
  process.exit(1);
});
