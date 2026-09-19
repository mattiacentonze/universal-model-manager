import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
  applyUniversalConfigRemoval,
  applyUniversalConfigUpdates,
  backupFile,
  removeUniversalConfig,
  setupOpenCodeConfig,
} from "../src/shared/config-writer.js";

/** Real on-disk checkout with the built entrypoints the installer links against. */
function fakeCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "uacheckout-"));
  mkdirSync(join(root, "dist", "antigravity"), { recursive: true });
  mkdirSync(join(root, "src", "tui"), { recursive: true });
  writeFileSync(join(root, "dist", "index.js"), "export default {};\n");
  writeFileSync(join(root, "dist", "antigravity", "index.js"), "export default {};\n");
  writeFileSync(join(root, "src", "tui", "entry.mjs"), "export default {};\n");
  return root;
}

function fakeConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "uaconf-"));
}

function refsFor(root: string) {
  return {
    main: pathToFileURL(join(root, "dist", "index.js")).href,
    antigravity: pathToFileURL(join(root, "dist", "antigravity", "index.js")).href,
    tui: pathToFileURL(join(root, "src", "tui", "entry.mjs")).href,
  };
}

const SCHEMA = `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`;

describe("applyUniversalConfigUpdates", () => {
  it("adds chatgpt-web provider and real file-URL plugins to a clean config", () => {
    const root = fakeCheckout();
    const { main, antigravity } = refsFor(root);
    const updated = applyUniversalConfigUpdates(SCHEMA, { localPluginPath: root, bridgePort: 17845 });
    const parsed = parse(updated);

    expect(parsed.provider["chatgpt-web"]).toBeDefined();
    expect(parsed.provider["chatgpt-web"].options.baseURL).toBe("http://127.0.0.1:17845/v1");
    expect(parsed.plugin).toContain(main);
    expect(parsed.plugin).toContain(antigravity);
  });

  it("emits loadable file URLs (not bare directories) pointing at the built entrypoints", () => {
    const root = fakeCheckout();
    const { main, antigravity } = refsFor(root);
    const updated = applyUniversalConfigUpdates(SCHEMA, { localPluginPath: root });
    const parsed = parse(updated);

    expect(parsed.plugin).toContain(main);
    expect(parsed.plugin).toContain(antigravity);
    expect(main).toMatch(/dist\/index\.js$/);
    expect(antigravity).toMatch(/dist\/antigravity\/index\.js$/);
    // The catastrophic old form "file:<dir>/antigravity" must never appear.
    expect(parsed.plugin).not.toContain(`file:${root}`);
    expect(parsed.plugin).not.toContain(`file:${root}/antigravity`);
    for (const ref of [main, antigravity]) expect(existsSync(new URL(ref))).toBe(true);
  });

  it("keeps unrelated cortexkit/runtime/model-router plugins when replaceLegacyPlugins is false", () => {
    const root = fakeCheckout();
    const { main } = refsFor(root);
    const original = `{
  "plugin": ["@cortexkit/opencode-openai-auth", "opencode-model-router"]
}`;
    const updated = applyUniversalConfigUpdates(original, {
      localPluginPath: root,
      replaceLegacyPlugins: false,
    });
    const parsed = parse(updated);
    expect(parsed.plugin).toContain("@cortexkit/opencode-openai-auth");
    expect(parsed.plugin).toContain("opencode-model-router");
    expect(parsed.plugin).toContain(main);
  });

  it("replaces legacy cortexkit, runtime-fallback and model-router by default", () => {
    const root = fakeCheckout();
    const { main, antigravity } = refsFor(root);
    const original = `{
  "provider": { "iit": { "name": "IIT" } },
  "plugin": [
    "@cortexkit/opencode-antigravity-auth",
    "@cortexkit/opencode-openai-auth",
    "opencode-runtime-fallback",
    "opencode-model-router",
    ["@cortexkit/opencode-openai-auth", { "opt": 1 }]
  ]
}`;
    const updated = applyUniversalConfigUpdates(original, { replaceLegacyPlugins: true, localPluginPath: root });
    const parsed = parse(updated);
    expect(parsed.provider.iit.name).toBe("IIT");
    expect(parsed.provider["chatgpt-web"]).toBeDefined();
    expect(parsed.plugin).not.toContain("@cortexkit/opencode-openai-auth");
    expect(parsed.plugin).not.toContain("@cortexkit/opencode-antigravity-auth");
    expect(parsed.plugin).not.toContain("opencode-runtime-fallback");
    expect(parsed.plugin).not.toContain("opencode-model-router");
    // tuple form of legacy names is removed too
    expect(parsed.plugin).not.toContainEqual(["@cortexkit/opencode-openai-auth", { opt: 1 }]);
    expect(parsed.plugin).toContain(main);
    expect(parsed.plugin).toContain(antigravity);
  });

  it("is strictly idempotent", () => {
    const root = fakeCheckout();
    const first = applyUniversalConfigUpdates(SCHEMA, { localPluginPath: root });
    const second = applyUniversalConfigUpdates(first, { localPluginPath: root });
    expect(second).toBe(first);
  });

  it("writes a flat agent map (no nested object model) only when writeAgentChains is true", () => {
    const root = fakeCheckout();
    const prev = {
      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
      OPENCODE_UNIVERSAL_AUTH_DIR: process.env.OPENCODE_UNIVERSAL_AUTH_DIR,
    };
    process.env.OPENCODE_CONFIG_DIR = fakeConfigDir();
    process.env.OPENCODE_UNIVERSAL_AUTH_DIR = mkdtempSync(join(tmpdir(), "uadata-"));
    try {
      const withChains = parse(applyUniversalConfigUpdates(SCHEMA, { localPluginPath: root, writeAgentChains: true }));
      expect(withChains.agent.fast.model).toBe("iit/deepseek-v4-flash");
      expect(typeof withChains.agent.fast.model).toBe("string");
      expect(withChains.agent.medium.variant).toBe("medium");
      // build orchestrator default mirrors the user's original routing: DeepSeek.
      expect(withChains.agent.build.model).toBe("iit/deepseek-v4-flash");
    } finally {
      if (prev.OPENCODE_CONFIG_DIR === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = prev.OPENCODE_CONFIG_DIR;
      if (prev.OPENCODE_UNIVERSAL_AUTH_DIR === undefined) delete process.env.OPENCODE_UNIVERSAL_AUTH_DIR;
      else process.env.OPENCODE_UNIVERSAL_AUTH_DIR = prev.OPENCODE_UNIVERSAL_AUTH_DIR;
    }
    // By default (writeAgentChains omitted) the user agent config is untouched.
    const withoutChains = parse(applyUniversalConfigUpdates(SCHEMA, { localPluginPath: root }));
    expect(withoutChains.agent).toBeUndefined();
  });

  it("throws on invalid JSONC", () => {
    expect(() => applyUniversalConfigUpdates('{"plugin": [')).toThrow(/valid JSONC/);
  });
});

describe("setupOpenCodeConfig (filesystem, isolated config dir)", () => {
  it("fresh install writes opencode.json and tui.json beside the explicit configPath", () => {
    const root = fakeCheckout();
    const dir = fakeConfigDir();
    const cfgPath = join(dir, "opencode.json");
    const res = setupOpenCodeConfig({ configPath: cfgPath, localPluginPath: root });
    expect(res.modified).toBe(true);
    expect(existsSync(cfgPath)).toBe(true);
    // The TUI file lives beside the explicit server config, never the live global.
    expect(existsSync(join(dir, "tui.json"))).toBe(true);
    const tui = parse(readFileSync(join(dir, "tui.json"), "utf8"));
    expect(tui.plugin).toContain(refsFor(root).tui);
  });

  it("preserves unrelated agent/settings keys when writing config and tui", () => {
    const root = fakeCheckout();
    const cfgPath = join(fakeConfigDir(), "opencode.json");
    writeFileSync(
      cfgPath,
      `{\n  "agent": { "coder": { "model": "x/y", "prompt": "keep" } },\n  "experimental": { "keep": true }\n}\n`,
    );
    setupOpenCodeConfig({ configPath: cfgPath, localPluginPath: root });
    const parsed = parse(readFileSync(cfgPath, "utf8"));
    expect(parsed.agent.coder.model).toBe("x/y");
    expect(parsed.agent.coder.prompt).toBe("keep");
    expect(parsed.experimental.keep).toBe(true);
  });

  it("is idempotent on reinstall", () => {
    const root = fakeCheckout();
    const cfgPath = join(fakeConfigDir(), "opencode.json");
    setupOpenCodeConfig({ configPath: cfgPath, localPluginPath: root });
    const second = setupOpenCodeConfig({ configPath: cfgPath, localPluginPath: root });
    expect(second.modified).toBe(false);
  });

  it("fails on invalid JSONC before writing anything", () => {
    const root = fakeCheckout();
    const cfgPath = join(fakeConfigDir(), "opencode.json");
    writeFileSync(cfgPath, '{"plugin": [');
    expect(() => setupOpenCodeConfig({ configPath: cfgPath, localPluginPath: root })).toThrow(/valid JSONC/);
    expect(readFileSync(cfgPath, "utf8")).toBe('{"plugin": [');
    expect(existsSync(join(dirname(cfgPath), "tui.json"))).toBe(false);
  });

  it("fails before writing when a built entrypoint is missing", () => {
    const root = fakeCheckout();
    const cfgPath = join(fakeConfigDir(), "opencode.json");
    rmSync(join(root, "dist", "index.js"));
    expect(() => setupOpenCodeConfig({ configPath: cfgPath, localPluginPath: root })).toThrow(/entrypoint missing/);
    expect(existsSync(cfgPath)).toBe(false);
  });
});

describe("removeUniversalConfig / applyUniversalConfigRemoval", () => {
  it("removes only managed plugin entries, tuples, and the managed chatgpt-web provider", () => {
    const root = fakeCheckout();
    const { main, antigravity } = refsFor(root);
    const original = `{
  "plugin": [
    "chatgpt-web",
    "${main}",
    "${antigravity}",
    ["@cortexkit/opencode-openai-auth", { "opt": 1 }],
    "opencode-model-router",
    "some-other-plugin",
    ["keep-tuple", { "a": 1 }]
  ],
  "provider": { "other": { "name": "Other" }, "chatgpt-web": { "npm": "@ai-sdk/openai", "options": { "baseURL": "http://127.0.0.1:17842/v1", "apiKey": "local-session" } } }
}`;
    const updated = applyUniversalConfigRemoval(original, root);
    const parsed = parse(updated);
    // Ownership removes only the manager's refs + legacy names; the unrelated
    // string plugin "chatgpt-web", "some-other-plugin" and "keep-tuple" stay.
    expect(parsed.plugin).toEqual(["chatgpt-web", "some-other-plugin", ["keep-tuple", { a: 1 }]]);
    expect(parsed.provider.other.name).toBe("Other");
    expect(parsed.provider["chatgpt-web"]).toBeUndefined();
  });

  it("never deletes a user-authored chatgpt provider", () => {
    const root = fakeCheckout();
    const { main } = refsFor(root);
    const original = `{
  "provider": { "chatgpt-web": { "npm": "custom-sdk", "options": { "apiKey": "user-key" } } },
  "plugin": ["${main}"]
}`;
    const parsed = parse(applyUniversalConfigRemoval(original, root));
    expect(parsed.plugin).toEqual([]);
    expect(parsed.provider["chatgpt-web"]).toBeDefined();
  });

  it("preserves unrelated cortexkit TUI entries and removes owned TUI entries", () => {
    const root = fakeCheckout();
    const { tui } = refsFor(root);
    const dir = fakeConfigDir();
    const cfgPath = join(dir, "opencode.json");
    writeFileSync(cfgPath, `{\n  "plugin": ["${refsFor(root).main}"]\n}\n`);
    const tuiPath = join(dir, "tui.json");
    writeFileSync(
      tuiPath,
      `{ "plugin": ["@cortexkit/opencode-openai-auth/tui", "${tui}", "opencode-universal-model-manager"] }`,
    );
    const res = removeUniversalConfig({ configPath: cfgPath, tuiConfigPath: tuiPath, localPluginPath: root });
    expect(res.modified).toBe(true);
    const tuiParsed = parse(readFileSync(tuiPath, "utf8"));
    expect(tuiParsed.plugin).toContain("@cortexkit/opencode-openai-auth/tui");
    expect(tuiParsed.plugin).not.toContain(tui);
    expect(tuiParsed.plugin).not.toContain("opencode-universal-model-manager");
  });

  it("reinstall then uninstall restores the config, and uninstall is idempotent", () => {
    const root = fakeCheckout();
    const cfgPath = join(fakeConfigDir(), "opencode.json");
    setupOpenCodeConfig({ configPath: cfgPath, localPluginPath: root });

    const rem = removeUniversalConfig({ configPath: cfgPath, localPluginPath: root });
    expect(rem.modified).toBe(true);
    const after = parse(readFileSync(cfgPath, "utf8"));
    expect(after.plugin).toEqual([]);
    expect(after.provider["chatgpt-web"]).toBeUndefined();

    const rem2 = removeUniversalConfig({ configPath: cfgPath, localPluginPath: root });
    expect(rem2.modified).toBe(false);
  });
});

describe("backupFile", () => {
  it("writes unique .bak names and never overwrites an existing backup", () => {
    const file = join(fakeConfigDir(), "opencode.json");
    writeFileSync(file, "a");
    backupFile(file);
    expect(existsSync(`${file}.bak`)).toBe(true);
    writeFileSync(file, "b");
    backupFile(file);
    expect(existsSync(`${file}.bak.1`)).toBe(true);
    expect(readFileSync(`${file}.bak`, "utf8")).toBe("a");
  });
});
