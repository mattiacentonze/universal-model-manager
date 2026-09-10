import type { Plugin } from "@opencode-ai/plugin";
import { BridgeServer } from "./bridge-server.js";
import { BrowserManager } from "./browser-manager.js";
import { ChatGptRunner } from "./chatgpt-runner.js";
import { SessionStore } from "./session-store.js";
import { logger } from "../shared/logger.js";

let activeServer: BridgeServer | null = null;

export async function getOrStartBridgeServer(port = 17842): Promise<BridgeServer> {
  if (activeServer) return activeServer;

  const sessionStore = new SessionStore();
  const browserManager = new BrowserManager(sessionStore);
  const runner = new ChatGptRunner(browserManager);

  activeServer = new BridgeServer({ port, runner, sessionStore });
  try {
    await activeServer.start();
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      logger.info(`Bridge port ${port} already bound by another daemon process.`);
    } else {
      throw err;
    }
  }
  return activeServer;
}

export const chatgptWebServerPlugin: Plugin = async (input, options) => {
  const port = typeof options?.port === "number" ? options.port : 17842;
  const sessionStore = new SessionStore();

  // Try starting the bridge server lazily in the background
  getOrStartBridgeServer(port).catch(err => {
    logger.warn(`Could not start bridge server automatically: ${err}`);
  });

  return {
    config: async (cfg: any) => {
      // Register custom slash commands
      if (!cfg.command) cfg.command = {};
      cfg.command["universal-chatgpt-web"] = {
        description: "Manage ChatGPT Web authentication and bridge status",
        template: "Command executed for ChatGPT Web management: $ARGUMENTS",
      };
    },

    "command.execute.before": async (data, output) => {
      if (data.command !== "universal-chatgpt-web") return;

      const args = (data.arguments || "").trim().split(/\s+/);
      const sub = args[0] || "status";

      if (sub === "status") {
        const hasSession = sessionStore.hasValidSession();
        output.parts.push({
          type: "text",
          text: `[Universal Auth] ChatGPT Web Status:\n- Session logged in: ${hasSession ? "YES" : "NO"}\n- Bridge endpoint: http://127.0.0.1:${port}/v1\n- Models: chatgpt-web/auto, chatgpt-web/pro, chatgpt-web/think, chatgpt-web/luna`,
        } as any);
        return;
      }

      if (sub === "login") {
        output.parts.push({
          type: "text",
          text: "[Universal Auth] Opening Chrome window for ChatGPT login. Please complete login in the opened browser...",
        } as any);

        const bm = new BrowserManager(sessionStore);
        bm.launchInteractiveLogin().then(ok => {
          if (ok) {
            logger.info("Interactive login completed successfully!");
          } else {
            logger.warn("Interactive login was not completed or failed.");
          }
        });
        return;
      }

      output.parts.push({
        type: "text",
        text: `Usage: /universal-chatgpt-web [status | login]`,
      } as any);
    },
  };
};

export default {
  id: "universal-chatgpt-web",
  server: chatgptWebServerPlugin,
};
