import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { managerHooks } from "../src/manager/hooks.js";

// The graphical TUI slash handlers own these names in the isolated OpenCode
// host. If the server registers or intercepts any of them, the text command
// shadows the /u-* dialog. Only status / universal-status / u-migrate may stay
// as server text commands.
const UI_OWNED = ["u-setup", "u-wizard", "u-accounts", "u-main", "u-fallbacks", "u-router", "u-reset"];
const SERVER_TEXT = ["u-status", "universal-status", "u-migrate"];

describe("server plugin does not shadow TUI-owned slash commands", () => {
  let hooks: ReturnType<typeof managerHooks>;
  beforeEach(() => {
    process.env.OPENCODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "srvcmd-"));
    process.env.OPENCODE_UNIVERSAL_AUTH_DIR = mkdtempSync(join(tmpdir(), "srvdata-"));
    hooks = managerHooks();
  });

  it("config.command keeps only the server text commands, none of the UI-owned names", async () => {
    const cfg: { command?: Record<string, unknown> } = {};
    await hooks.config?.(cfg as never);
    const commands = Object.keys(cfg.command!);
    for (const name of UI_OWNED) expect(commands).not.toContain(name);
    for (const name of SERVER_TEXT) expect(commands).toContain(name);
  });

  it("command.execute.before does not intercept UI-owned names", async () => {
    for (const name of UI_OWNED) {
      const output = { parts: [] as { type: string; text: string }[] };
      await hooks["command.execute.before"]?.({ command: name, arguments: "" } as never, output as never);
      expect(output.parts, `${name} must not be shadowed by a server text part`).toHaveLength(0);
    }
  });

  it("command.execute.before still serves the kept server text commands", async () => {
    for (const name of SERVER_TEXT) {
      const output = { parts: [] as { type: string; text: string }[] };
      await hooks["command.execute.before"]?.({ command: name, arguments: "" } as never, output as never);
      expect(output.parts.length, `${name} should produce a status text`).toBeGreaterThan(0);
    }
  });
});
