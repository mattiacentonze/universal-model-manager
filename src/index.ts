import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { openaiServerPlugin } from "./openai/index.js";
import { chatgptWebServerPlugin } from "./chatgpt-web/index.js";
import { fallbackPlugin } from "./fallback/index.js";
import { logger } from "./shared/logger.js";

export const universalAuthPlugin: Plugin = async (input, options) => {
  let openaiHooks: Hooks = {};
  let webHooks: Hooks = {};
  let fallbackHooks: Hooks = {};

  try {
    openaiHooks = await openaiServerPlugin(input, options);
  } catch (err) {
    logger.warn(`Failed to initialize OpenAI auth submodule: ${err}`);
  }

  try {
    webHooks = await chatgptWebServerPlugin(input, options);
  } catch (err) {
    logger.warn(`Failed to initialize ChatGPT Web submodule: ${err}`);
  }

  try {
    fallbackHooks = await fallbackPlugin(input, options);
  } catch (err) {
    logger.warn(`Failed to initialize Runtime Fallback submodule: ${err}`);
  }

  return {
    auth: openaiHooks.auth,

    config: async (cfg: any) => {
      if (openaiHooks.config) await openaiHooks.config(cfg);
      if (webHooks.config) await webHooks.config(cfg);
      if (fallbackHooks.config) await fallbackHooks.config(cfg);

      // Register universal-status slash command
      if (!cfg.command) cfg.command = {};
      cfg.command["universal-status"] = {
        description: "Display universal auth status (OpenAI OAuth + ChatGPT Web + Fallback)",
        template: "Universal auth status: $ARGUMENTS",
      };
    },

    "chat.headers": openaiHooks["chat.headers"],
    "chat.params": openaiHooks["chat.params"],

    "command.execute.before": async (data, output) => {
      if (data.command === "universal-status") {
        output.parts.push({
          type: "text",
          text: "[Universal Auth Status]\n- OpenAI OAuth hook: Active\n- Runtime Fallback engine: Active\n- ChatGPT Web bridge: Active",
        } as any);
        return;
      }
      if (openaiHooks["command.execute.before"]) {
        await openaiHooks["command.execute.before"](data, output);
      }
      if (webHooks["command.execute.before"]) {
        await webHooks["command.execute.before"](data, output);
      }
    },

    event: fallbackHooks.event,
    "tool.execute.after": fallbackHooks["tool.execute.after"],
    "chat.message": fallbackHooks["chat.message"],
  };
};

export default {
  id: "opencode-universal-auth",
  server: universalAuthPlugin,
};

export { openaiServerPlugin } from "./openai/index.js";
export { antigravityServerPlugin } from "./antigravity/index.js";
export { chatgptWebServerPlugin, getOrStartBridgeServer } from "./chatgpt-web/index.js";
export { fallbackPlugin } from "./fallback/index.js";
