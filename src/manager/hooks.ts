import type { Hooks } from "@opencode-ai/plugin";
import { handleManagerCommand, summarize, loadConfig } from "./index.js";
import { getOpenCodeConfigDir } from "../shared/paths.js";

// Only status / universal-status / u-migrate stay as server text commands; the
// remaining u-* management names (setup, wizard, accounts, main, router,
// fallbacks, reset) are owned by the graphical TUI slash handlers, so a server
// text registration or interceptor would shadow those dialogs in the host.
const SERVER_TEXT = ["u-status", "universal-status", "u-migrate"];

/** Manager server hooks: config command registrations + text command handler. */
export function managerHooks(): Hooks {
  return {
    config: async (cfg: any) => {
      cfg.command ??= {};
      cfg.command["u-status"] = { description: "Unified provider + manager status", template: "Manager status: $ARGUMENTS" };
      cfg.command["u-migrate"] = { description: "Run manager config migration", template: "Migrate: $ARGUMENTS" };
      cfg.command["universal-status"] = { description: "Display unified status (alias)", template: "Universal status: $ARGUMENTS" };
      cfg.command["antigravity-routing"] = { description: "Configure Google Antigravity account routing strategy", template: "antigravity-routing" };
      cfg.command["google-routing"] = { description: "Configure Google account routing strategy (alias)", template: "google-routing" };
    },
    "command.execute.before": async (data: any, output: any) => {
      const cmd = data?.command || "";
      if (!SERVER_TEXT.includes(cmd)) return;
      const args = data?.arguments || "";
      const handled = await handleManagerCommand(cmd, args, undefined, getOpenCodeConfigDir());
      if (handled) output.parts.push({ type: "text", text: handled.text });
      else if (["u-status", "universal-status"].includes(cmd)) output.parts.push({ type: "text", text: summarize(loadConfig()) });
    },
  };
}
