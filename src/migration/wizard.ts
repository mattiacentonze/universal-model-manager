import * as readline from "node:readline";
import { setupOpenCodeConfig } from "../shared/config-writer.js";
import { cleanOpenCodePlugins, cleanTuiConfig, uninstallLegacyNpmPackages } from "./cleaner.js";
import { detectLegacyPluginsAndConfigs } from "./detector.js";
import { executeMigration } from "./importer.js";
import type { DiscoveryReport, MigrationPlan, MigrationResult } from "./types.js";

export function formatDiscoveryReport(report: DiscoveryReport): string {
  const lines: string[] = [];
  lines.push("╭────────────────────────────────────────────────────────────────────────────╮");
  lines.push("│                 Universal Model Manager - Migration Scan                   │");
  lines.push("╰────────────────────────────────────────────────────────────────────────────╯\n");

  if (report.items.length === 0) {
    lines.push("No legacy plugins or configurations detected. Environment is clean.\n");
    return lines.join("\n");
  }

  lines.push("🔎 DISCOVERED LEGACY PLUGINS & CONFIGURATIONS:\n");
  for (const item of report.items) {
    lines.push(`  ● ${item.name} (${item.id})`);
    lines.push(`    Description: ${item.description}`);
    lines.push(`    Active in OpenCode config: ${item.foundInConfig ? "YES" : "NO"}`);
    if (item.foundFiles.length > 0) {
      lines.push(`    Files detected: ${item.foundFiles.join(", ")}`);
    }
    if (item.secretsDetected.length > 0) {
      lines.push(`    🔒 Secrets/Tokens: ${item.secretsDetected.join("; ")}`);
    }
    lines.push("");
  }

  if (report.hasConflictsWithUniversalManager) {
    lines.push("⚠️  POTENTIAL CONFLICT WARNING:");
    lines.push("   Keeping legacy plugins active in opencode.jsonc alongside universal-model-manager");
    lines.push("   will cause hook collisions in OpenCode (e.g. conflicting OpenAI OAuth intercepts,");
    lines.push("   duplicate runtime-fallback error retries).");
    lines.push("   We recommend replacing them with universal-model-manager, which unifies all features.\n");
  }

  return lines.join("\n");
}

function askQuestion(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

export async function runInteractiveMigration(
  options: { dryRun?: boolean; autoConfirm?: boolean; uninstallNpm?: boolean } = {},
): Promise<MigrationResult> {
  const report = detectLegacyPluginsAndConfigs();
  console.log(formatDiscoveryReport(report));

  if (report.items.length === 0) {
    console.log("Nothing to migrate. Run 'universal-model-manager setup' to initialize config.");
    return {
      success: true,
      importedItems: [],
      configModified: false,
      tuiModified: false,
      uninstalledPackages: [],
      errors: [],
    };
  }

  const plan: MigrationPlan = {
    importOpenAi: report.items.some((i) => i.id === "cortexkit-openai"),
    importAntigravity: report.items.some((i) => i.id === "cortexkit-antigravity"),
    importFallback: report.items.some((i) => i.id === "runtime-fallback"),
    importChatGptWeb: report.items.some((i) => i.id === "codex-chatgpt-web"),
    replaceInOpenCodeConfig: true,
    replaceInTuiConfig: true,
    uninstallLegacyNpmPackages: options.uninstallNpm ?? false,
  };

  if (!options.autoConfirm && process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      const ansImport = (
        await askQuestion(rl, "1. Import all detected settings, accounts, and session cookies? [Y/n]: ")
      )
        .trim()
        .toLowerCase();
      if (ansImport === "n" || ansImport === "no") {
        console.log("Migration cancelled by user.");
        rl.close();
        return {
          success: true,
          importedItems: [],
          configModified: false,
          tuiModified: false,
          uninstalledPackages: [],
          errors: [],
        };
      }

      const ansReplace = (
        await askQuestion(
          rl,
          "2. Replace legacy plugins in opencode.jsonc & tui.json with universal-model-manager? [Y/n]: ",
        )
      )
        .trim()
        .toLowerCase();
      plan.replaceInOpenCodeConfig = ansReplace !== "n" && ansReplace !== "no";
      plan.replaceInTuiConfig = plan.replaceInOpenCodeConfig;

      const ansUninstall = (
        await askQuestion(rl, "3. Also run 'npm uninstall' for legacy packages in ~/.config/opencode? [y/N]: ")
      )
        .trim()
        .toLowerCase();
      plan.uninstallLegacyNpmPackages = ansUninstall === "y" || ansUninstall === "yes";
    } finally {
      rl.close();
    }
  }

  if (options.dryRun) {
    console.log("\n[DRY RUN] Migration plan prepared:");
    console.log(JSON.stringify(plan, null, 2));
    return {
      success: true,
      importedItems: ["Dry run completed"],
      configModified: false,
      tuiModified: false,
      uninstalledPackages: [],
      errors: [],
    };
  }

  console.log("\nExecuting migration...");
  const result = executeMigration(report, plan);

  if (plan.replaceInOpenCodeConfig) {
    setupOpenCodeConfig({ replaceLegacyPlugins: true });
    cleanOpenCodePlugins();
    result.configModified = true;
    console.log("✓ Updated opencode.jsonc (added chatgpt-web provider and universal-model-manager)");
  }

  if (plan.replaceInTuiConfig) {
    cleanTuiConfig();
    result.tuiModified = true;
    console.log("✓ Updated tui.json (registered universal-model-manager TUI widget)");
  }

  if (plan.uninstallLegacyNpmPackages) {
    console.log("Uninstalling legacy npm packages from ~/.config/opencode...");
    const uninstalled = uninstallLegacyNpmPackages();
    result.uninstalledPackages = uninstalled;
    if (uninstalled.length > 0) {
      console.log(`✓ Uninstalled: ${uninstalled.join(", ")}`);
    } else {
      console.log("✓ No legacy packages found to uninstall.");
    }
  }

  console.log("\n=== Migration Completed Successfully ===");
  if (result.importedItems.length > 0) {
    console.log("Imported items:");
    for (const item of result.importedItems) {
      console.log(`  - ${item}`);
    }
  }
  console.log(
    "\nUniversal Model Manager is now your single active manager for OpenAI, Antigravity, ChatGPT Web, and Fallback!",
  );

  return result;
}
