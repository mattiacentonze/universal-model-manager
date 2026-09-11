import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";
import { getOpenCodeConfigDir } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

const LEGACY_PLUGINS = [
  "@cortexkit/opencode-openai-auth",
  "@cortexkit/opencode-antigravity-auth",
  "opencode-runtime-fallback",
];

export function cleanOpenCodePlugins(configPath?: string): boolean {
  const file = configPath || join(getOpenCodeConfigDir(), "opencode.jsonc");
  if (!existsSync(file)) return false;

  try {
    const original = readFileSync(file, "utf8");
    const parsed = parse(original) || {};
    let plugins = Array.isArray(parsed.plugin) ? [...parsed.plugin] : [];

    // Filter out legacy plugins
    const previousLen = plugins.length;
    plugins = plugins.filter(
      p => !LEGACY_PLUGINS.some(legacy => typeof p === "string" && (p === legacy || p.startsWith(`${legacy}@`)))
    );

    // Add universal-model-manager entries if missing
    const required = ["universal-model-manager", "universal-model-manager/antigravity"];
    for (const req of required) {
      if (!plugins.includes(req)) {
        plugins.push(req);
      }
    }

    const edits = modify(original, ["plugin"], plugins, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    const updated = applyEdits(original, edits);

    if (original !== updated) {
      writeFileSync(file, updated, "utf8");
      logger.info(`Updated plugins in ${file}`);
      return true;
    }
  } catch (err) {
    logger.error(`Failed to clean plugins in ${file}: ${err}`);
  }
  return false;
}

export function cleanTuiConfig(tuiPath?: string): boolean {
  const file = tuiPath || join(getOpenCodeConfigDir(), "tui.json");
  if (!existsSync(file)) return false;

  try {
    const original = readFileSync(file, "utf8");
    const parsed = parse(original) || {};
    let plugins = Array.isArray(parsed.plugin) ? [...parsed.plugin] : [];

    plugins = plugins.filter(
      p => typeof p === "string" && !p.includes("cortexkit")
    );

    if (!plugins.includes("universal-model-manager")) {
      plugins.unshift("universal-model-manager");
    }

    const edits = modify(original, ["plugin"], plugins, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    const updated = applyEdits(original, edits);

    if (original !== updated) {
      writeFileSync(file, updated, "utf8");
      logger.info(`Updated plugins in ${file}`);
      return true;
    }
  } catch (err) {
    logger.error(`Failed to clean TUI plugins in ${file}: ${err}`);
  }
  return false;
}

export function uninstallLegacyNpmPackages(configDir = getOpenCodeConfigDir()): string[] {
  const pkgJsonPath = join(configDir, "package.json");
  if (!existsSync(pkgJsonPath)) return [];

  const uninstalled: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    const deps = pkg.dependencies || {};

    const packagesToRemove = LEGACY_PLUGINS.filter(name => deps[name]);
    if (packagesToRemove.length > 0) {
      logger.info(`Running npm uninstall in ${configDir} for: ${packagesToRemove.join(", ")}`);
      execSync(`npm uninstall ${packagesToRemove.join(" ")}`, {
        cwd: configDir,
        stdio: "pipe",
      });
      uninstalled.push(...packagesToRemove);
    }
  } catch (err) {
    logger.error(`npm uninstall error: ${err}`);
  }
  return uninstalled;
}
