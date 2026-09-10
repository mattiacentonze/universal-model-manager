import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { usageTracker } from "./chatgpt-web/usage-tracker.js";

export const tui: TuiPlugin = async (api: TuiPluginApi, options, meta) => {
  // 1. Delegate to OpenAI TUI widget if installed
  try {
    // @ts-ignore
    const openaiTui = await import("@cortexkit/opencode-openai-auth/tui");
    if (openaiTui && typeof openaiTui.default?.tui === "function") {
      await openaiTui.default.tui(api, options, meta);
    }
  } catch {
    // Ignored if not available in host environment
  }

  // 2. Delegate to Antigravity TUI widget if installed
  try {
    // @ts-ignore
    const antigravityTui = await import("@cortexkit/opencode-antigravity-auth/tui");
    if (antigravityTui && typeof antigravityTui.default?.tui === "function") {
      await antigravityTui.default.tui(api, options, meta);
    }
  } catch {
    // Ignored if not available in host environment
  }

  // 3. Register ChatGPT Web sidebar content slot
  if (api.slots && typeof api.slots.register === "function") {
    api.slots.register({
      order: 350,
      slots: {
        sidebar_content: () => {
          const status = usageTracker.getStatus();
          const lines = [
            "ChatGPT Web",
            `  Status: ${status.isLoggedIn ? "Active" : "Logged Out"}`,
            `  Turns (3h): ${status.turnsInWindow}`,
          ];
          if (status.isRateLimited) {
            lines.push(`  Limit until: ${status.rateLimitResetFormatted || "Active"}`);
          }
          return lines.join("\n");
        },
      },
    });
  }
};

const plugin: TuiPluginModule & { id: string } = {
  id: "universal-auth-tui",
  tui,
};

export default plugin;
