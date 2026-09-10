import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";
import { getOpenCodeConfigDir } from "./paths.js";

export interface SetupOptions {
  configPath?: string;
  tuiConfigPath?: string;
  bridgePort?: number;
  replaceLegacyPlugins?: boolean;
}

export function findOpenCodeConfigFile(dir = getOpenCodeConfigDir()): string {
  const jsonc = join(dir, "opencode.jsonc");
  if (existsSync(jsonc)) return jsonc;
  const json = join(dir, "opencode.json");
  if (existsSync(json)) return json;
  return jsonc;
}

export function findTuiConfigFile(dir = getOpenCodeConfigDir()): string {
  return join(dir, "tui.json");
}

export function applyUniversalConfigUpdates(content: string, options: SetupOptions = {}): string {
  const port = options.bridgePort ?? 17842;
  const replaceLegacy = options.replaceLegacyPlugins ?? true;
  const parsed = parse(content) || {};
  let current = content;

  // 1. Ensure provider["chatgpt-web"] exists
  const providerDef = {
    npm: "@ai-sdk/openai",
    name: "ChatGPT Web",
    options: {
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: "local-session",
    },
    models: {
      "chatgpt-web/auto": {
        name: "ChatGPT Web (Auto)",
      },
      "chatgpt-web/pro": {
        name: "ChatGPT Web (Pro)",
      },
      "chatgpt-web/think": {
        name: "ChatGPT Web (Think)",
      },
      "chatgpt-web/luna": {
        name: "ChatGPT Web (Luna)",
      },
    },
  };

  const providerEdits = modify(current, ["provider", "chatgpt-web"], providerDef, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  current = applyEdits(current, providerEdits);

  // 2. Manage plugins array
  let plugins = Array.isArray(parsed.plugin) ? [...parsed.plugin] : [];

  if (replaceLegacy) {
    // Remove legacy plugins being superseded
    const legacyNames = [
      "@cortexkit/opencode-openai-auth",
      "@cortexkit/opencode-antigravity-auth",
      "opencode-runtime-fallback",
    ];
    plugins = plugins.filter(
      p => !legacyNames.some(legacy => typeof p === "string" && (p === legacy || p.startsWith(`${legacy}@`)))
    );
  }

  // Ensure universal auth plugins are present
  const requiredPlugins = ["opencode-universal-auth", "opencode-universal-auth/antigravity"];
  for (const req of requiredPlugins) {
    if (!plugins.includes(req) && !plugins.some((p: unknown) => typeof p === "string" && p === req)) {
      plugins.push(req);
    }
  }

  const pluginEdits = modify(current, ["plugin"], plugins, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  current = applyEdits(current, pluginEdits);

  return current;
}

export function setupOpenCodeConfig(options: SetupOptions = {}): { path: string; modified: boolean } {
  const file = options.configPath || findOpenCodeConfigFile();
  const original = existsSync(file) ? readFileSync(file, "utf8") : "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n";
  const updated = applyUniversalConfigUpdates(original, options);

  let modified = false;
  if (original !== updated) {
    writeFileSync(file, updated, "utf8");
    modified = true;
  }

  // Update tui.json if requested
  const tuiFile = options.tuiConfigPath || findTuiConfigFile();
  if (existsSync(tuiFile)) {
    try {
      const originalTui = readFileSync(tuiFile, "utf8");
      const parsedTui = parse(originalTui) || {};
      let tuiPlugins = Array.isArray(parsedTui.plugin) ? [...parsedTui.plugin] : [];

      if (options.replaceLegacyPlugins ?? true) {
        tuiPlugins = tuiPlugins.filter(
          p => typeof p === "string" && !p.includes("cortexkit")
        );
      }
      if (!tuiPlugins.includes("opencode-universal-auth")) {
        tuiPlugins.unshift("opencode-universal-auth");
      }

      const tuiEdits = modify(originalTui, ["plugin"], tuiPlugins, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      const updatedTui = applyEdits(originalTui, tuiEdits);
      if (originalTui !== updatedTui) {
        writeFileSync(tuiFile, updatedTui, "utf8");
        modified = true;
      }
    } catch {
      // Ignored if tui.json cannot be parsed
    }
  }

  return { path: file, modified };
}
