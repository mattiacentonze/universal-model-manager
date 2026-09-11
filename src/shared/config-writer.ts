import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyEdits, modify, parse } from "jsonc-parser";
import { getOpenCodeConfigDir } from "./paths.js";
import { loadConfig, tierTargets } from "../manager/index.js";
import { PLUGIN_ID, PLUGIN_ALIASES } from "./constants.js";

export interface SetupOptions {
  configPath?: string;
  tuiConfigPath?: string;
  bridgePort?: number;
  replaceLegacyPlugins?: boolean;
  /** Merge flat per-tier + build agent models. Defaults to false: the runtime manager owns agents, so user agent config is left untouched. */
  writeAgentChains?: boolean;
  /** Back up original files (unique names, never overwriting an existing .bak) before writing. */
  backup?: boolean;
  /**
   * Absolute path to this package's local (unpublished) checkout root. Plugin
   * entries are written as real `file:` URLs to the built entrypoints
   * (`dist/index.js`, `dist/antigravity/index.js`) and the TUI entry
   * (`src/tui/entry.mjs`). Defaults to the checkout inferred from this module's
   * import.meta.url.
   */
  localPluginPath?: string;
}

interface Refs {
  root: string;
  main: string;
  antigravity: string;
  tui: string;
}

const FMT = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

/** This module always lives two levels below the package root (src/shared or dist/shared). */
function inferRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function refsFor(root: string): Refs {
  return {
    root,
    main: pathToFileURL(resolve(root, "dist/index.js")).href,
    antigravity: pathToFileURL(resolve(root, "dist/antigravity/index.js")).href,
    tui: pathToFileURL(resolve(root, "src/tui/entry.mjs")).href,
  };
}

function refsForOptions(options: SetupOptions): Refs {
  return refsFor(options.localPluginPath ? resolve(options.localPluginPath) : inferRoot());
}

/** Registry/id names this manager owns for removal (strings and "name@version" style). */
function ownedNames(refs: Refs): string[] {
  return [
    PLUGIN_ID,
    `${PLUGIN_ID}/antigravity`,
    ...PLUGIN_ALIASES,
    "@cortexkit/opencode-openai-auth",
    "@cortexkit/opencode-antigravity-auth",
    "opencode-runtime-fallback",
    "opencode-model-router",
    refs.main,
    refs.antigravity,
    refs.tui,
  ];
}

function matchesOwned(name: string | undefined | null, owned: string[]): boolean {
  if (!name) return false;
  if (owned.includes(name)) return true;
  return owned.some(base => !base.startsWith("file:") && name.startsWith(`${base}@`));
}

/** Plugin entries may be a bare string or a `[name, options]` tuple. */
function pluginName(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
  return undefined;
}

/** Parse JSONC strictly; invalid config must throw so no write ever happens. */
function parseStrict(content: string): any {
  const errors: unknown[] = [];
  const value = parse(content, errors as any, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new Error("Refusing to modify: config is not valid JSONC (failed to parse).");
  }
  return value;
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

/** Unique backup name: never overwrite an existing .bak. */
function freshBackupName(file: string): string {
  let name = `${file}.bak`;
  for (let i = 1; existsSync(name); i++) name = `${file}.bak.${i}`;
  return name;
}

export function backupFile(file: string): string | null {
  if (!existsSync(file)) return null;
  const backup = freshBackupName(file);
  writeFileSync(backup, readFileSync(file, "utf8"), "utf8");
  return backup;
}

function writeJsonc(file: string, content: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

function chatgptProvider(bridgePort: number): Record<string, unknown> {
  return {
    npm: "@ai-sdk/openai",
    name: "ChatGPT Web",
    options: { baseURL: `http://127.0.0.1:${bridgePort}/v1`, apiKey: "local-session" },
    models: {
      "chatgpt-web/auto": { name: "ChatGPT Web (Auto)" },
      "chatgpt-web/pro": { name: "ChatGPT Web (Pro)" },
      "chatgpt-web/think": { name: "ChatGPT Web (Think)" },
      "chatgpt-web/luna": { name: "ChatGPT Web (Luna)" },
    },
  };
}

/** Flat agent map matching the runtime manager protocol (no nested object model). */
function flatAgentMap(router: any): { tiers: Record<string, Record<string, unknown>>; build: Record<string, unknown> } {
  const tiers: Record<string, Record<string, unknown>> = {};
  for (const tier of ["fast", "medium", "heavy"] as const) {
    const chain = router.tiers[tier];
    const a: Record<string, unknown> = {
      model: chain.model,
      mode: "subagent",
      fallback_models: tierTargets(chain).map((t: any) => t.model),
    };
    if (chain.variant) a.variant = chain.variant;
    tiers[tier] = a;
  }
  return { tiers, build: { model: router.orchestrator } };
}

export function applyUniversalConfigUpdates(content: string, options: SetupOptions = {}): string {
  const port = options.bridgePort ?? 17842;
  const replaceLegacy = options.replaceLegacyPlugins ?? true;
  const refs = refsForOptions(options);
  const owned = ownedNames(refs);
  const parsed = parseStrict(content);
  let current = content;

  current = applyEdits(current, modify(current, ["provider", "chatgpt-web"], chatgptProvider(port), FMT));

  const ownRefs: string[] = [PLUGIN_ID, `${PLUGIN_ID}/antigravity`, ...PLUGIN_ALIASES, refs.main, refs.antigravity];
  const toRemove = replaceLegacy ? owned : ownRefs;
  let plugins = Array.isArray(parsed.plugin) ? [...parsed.plugin] : [];
  plugins = plugins.filter(p => !matchesOwned(pluginName(p), toRemove));
  plugins.push(refs.main, refs.antigravity);

  current = applyEdits(current, modify(current, ["plugin"], plugins, FMT));

  if (options.writeAgentChains === true) {
    const agentCfg: any =
      parsed.agent && typeof parsed.agent === "object" ? { ...parsed.agent } : {};
    const map = flatAgentMap(loadConfig().router);
    const buildModel = map.build.model;
    for (const tier of ["fast", "medium", "heavy"] as const) agentCfg[tier] = map.tiers[tier];
    agentCfg.build =
      agentCfg.build && typeof agentCfg.build === "object"
        ? { ...agentCfg.build, model: buildModel }
        : { ...map.build };
    current = applyEdits(current, modify(current, ["agent"], agentCfg, FMT));
  }

  return current;
}

/** Remove only entries this manager owns (plugin ids, local refs, legacy ones we replaced, managed chatgpt-web provider). User agent/settings and non-managed providers are untouched. */
export function applyUniversalConfigRemoval(content: string, root?: string): string {
  const refs = root ? refsFor(resolve(root)) : refsForOptions({});
  const owned = ownedNames(refs);
  const parsed = parseStrict(content);
  let current = content;

  const plugins = Array.isArray(parsed.plugin)
    ? parsed.plugin.filter((p: unknown) => !matchesOwned(pluginName(p), owned))
    : [];
  current = applyEdits(current, modify(current, ["plugin"], plugins, FMT));

  const cp = parsed.provider?.["chatgpt-web"];
  if (cp && typeof cp === "object" && (cp as any)?.npm === "@ai-sdk/openai" && (cp as any)?.options?.apiKey === "local-session") {
    current = applyEdits(current, modify(current, ["provider", "chatgpt-web"], undefined, FMT));
  }

  return current;
}

function removeTuiEntries(content: string, refs: Refs): { content: string; changed: boolean } {
  const owned = ownedNames(refs).filter(o => o === refs.tui || o === PLUGIN_ID || PLUGIN_ALIASES.includes(o));
  const parsed = parseStrict(content);
  const plugins = Array.isArray(parsed.plugin)
    ? (parsed.plugin as unknown[]).filter(p => !matchesOwned(pluginName(p), owned))
    : [];
  const updated = applyEdits(content, modify(content, ["plugin"], plugins, FMT));
  return { content: updated, changed: updated !== content };
}

export function removeUniversalConfig(options: { configPath?: string; tuiConfigPath?: string; backup?: boolean; localPluginPath?: string } = {}): { path: string; modified: boolean } {
  const refs = refsForOptions({ localPluginPath: options.localPluginPath });
  const file = options.configPath || findOpenCodeConfigFile();
  const tuiFile = options.tuiConfigPath || (options.configPath ? join(dirname(options.configPath), "tui.json") : findTuiConfigFile());

  if (!existsSync(file) && !existsSync(tuiFile)) return { path: file, modified: false };

  const serverOriginal = existsSync(file) ? readFileSync(file, "utf8") : null;
  const tuiOriginal = existsSync(tuiFile) ? readFileSync(tuiFile, "utf8") : null;
  if (serverOriginal !== null) parseStrict(serverOriginal);
  if (tuiOriginal !== null) parseStrict(tuiOriginal);

  const serverUpdated = serverOriginal !== null ? applyUniversalConfigRemoval(serverOriginal, refs.root) : null;
  const tui = tuiOriginal !== null ? removeTuiEntries(tuiOriginal, refs) : null;

  let modified = false;
  if (options.backup) {
    if (serverOriginal !== null && serverUpdated !== serverOriginal) backupFile(file);
    if (tui && tui.changed) backupFile(tuiFile);
  }
  if (serverUpdated !== null && serverUpdated !== serverOriginal) {
    writeJsonc(file, serverUpdated);
    modified = true;
  }
  if (tui && tui.changed) {
    writeJsonc(tuiFile, tui.content);
    modified = true;
  }
  return { path: file, modified };
}

export function setupOpenCodeConfig(options: SetupOptions = {}): { path: string; modified: boolean } {
  const refs = refsForOptions(options);
  // Fail fast on a local checkout missing its built entrypoints — before any write.
  for (const f of [`${refs.root}/dist/index.js`, `${refs.root}/dist/antigravity/index.js`, `${refs.root}/src/tui/entry.mjs`]) {
    if (!existsSync(f)) throw new Error(`Local package entrypoint missing: ${f}. Run 'npm run build' first.`);
  }

  const file = options.configPath || findOpenCodeConfigFile();
  const original = existsSync(file) ? readFileSync(file, "utf8") : "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n";
  const updated = applyUniversalConfigUpdates(original, options);
  const serverChanged = updated !== original;

  // When an explicit server config is supplied, its TUI lives beside it — never default to the live global.
  const tuiFile = options.tuiConfigPath || (options.configPath ? join(dirname(options.configPath), "tui.json") : findTuiConfigFile());
  const originalTui = existsSync(tuiFile) ? readFileSync(tuiFile, "utf8") : "{}";
  const parsedTui = parseStrict(originalTui);
  const owned = ownedNames(refs).filter(o => o === refs.tui || o === PLUGIN_ID || PLUGIN_ALIASES.includes(o));
  let tuiPlugins = Array.isArray(parsedTui.plugin) ? [...parsedTui.plugin] : [];
  tuiPlugins = tuiPlugins.filter(p => !matchesOwned(pluginName(p), owned));
  if (!tuiPlugins.includes(refs.tui)) tuiPlugins.unshift(refs.tui);
  const updatedTui = applyEdits(originalTui, modify(originalTui, ["plugin"], tuiPlugins, FMT));
  const tuiChanged = updatedTui !== originalTui || !existsSync(tuiFile);

  if (!serverChanged && !tuiChanged) return { path: file, modified: false };

  if (options.backup) {
    if (serverChanged) backupFile(file);
    if (existsSync(tuiFile) && tuiChanged) backupFile(tuiFile);
  }
  if (serverChanged) writeJsonc(file, updated);
  if (tuiChanged) writeJsonc(tuiFile, updatedTui);

  return { path: file, modified: true };
}
