import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, format, modify, parse } from "jsonc-parser";
import { getOpenCodeConfigDir } from "./paths.js";

export interface SetupOptions {
  configPath?: string;
  bridgePort?: number;
  enableFallback?: boolean;
}

export function findOpenCodeConfigFile(dir = getOpenCodeConfigDir()): string {
  const jsonc = join(dir, "opencode.jsonc");
  if (existsSync(jsonc)) return jsonc;
  const json = join(dir, "opencode.json");
  if (existsSync(json)) return json;
  return jsonc;
}

export function applyUniversalConfigUpdates(content: string, options: SetupOptions = {}): string {
  const port = options.bridgePort ?? 17842;
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

  // 2. Ensure opencode-universal-auth is in the plugins array
  const plugins = Array.isArray(parsed.plugin) ? [...parsed.plugin] : [];
  const requiredPlugins = ["opencode-universal-auth"];
  for (const req of requiredPlugins) {
    if (!plugins.includes(req) && !plugins.some((p: unknown) => typeof p === "string" && p.startsWith(req))) {
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

  if (original !== updated) {
    writeFileSync(file, updated, "utf8");
    return { path: file, modified: true };
  }
  return { path: file, modified: false };
}
