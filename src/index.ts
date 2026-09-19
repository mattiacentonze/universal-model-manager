import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { chatgptWebServerPlugin } from "./chatgpt-web/index.js";
import { fallbackPlugin } from "./fallback/index.js";
import { composeHooks } from "./hooks/compose.js";
import { managerHooks } from "./manager/hooks.js";
import { createQuotaPoller } from "./manager/quota-poller.js";
import ModelRouterPlugin from "./model-router/index.js";
import { openaiServerPlugin } from "./openai/index.js";
import { opencodeZenServerPlugin } from "./opencode-zen/index.js";

import { PLUGIN_ID } from "./shared/constants.js";

/** The OpenCode server plugin for this package: composes all submodules. */
export const universalModelManagerPlugin: Plugin = async (input, options) => {
  // Auth and fallback are required core: fail loudly instead of silently
  // claiming active with empty hooks.
  const [openaiHooks, webHooks, fallbackHooks, zenHooks, routingHooks] = await Promise.all([
    openaiServerPlugin(input, options),
    chatgptWebServerPlugin(input, options),
    fallbackPlugin(input, options),
    opencodeZenServerPlugin(input, options),
    ModelRouterPlugin(input, options),
  ]);

  const managerServerHooks = managerHooks();

  const quotaPoller = createQuotaPoller(input.directory);
  const quotaHooks = {
    event: quotaPoller.eventHandler,
    dispose: quotaPoller.dispose,
  };

  // The model-router populates the tier agents FIRST so the runtime fallback
  // config hook (composed after) captures the per-agent fallback chains.
  return composeHooks(routingHooks, openaiHooks, webHooks, fallbackHooks, zenHooks, managerServerHooks, quotaHooks);
};

const plugin: PluginModule & { id: string } = { id: PLUGIN_ID, server: universalModelManagerPlugin };

export default plugin;

export { antigravityServerPlugin, antigravityServerPlugin as antigravityAuth } from "./antigravity/index.js";
export { chatgptWebServerPlugin, getOrStartBridgeServer } from "./chatgpt-web/index.js";
export { fallbackPlugin } from "./fallback/index.js";
export { composeHooks } from "./hooks/compose.js";
export * from "./manager/index.js";
export { openaiServerPlugin, openaiServerPlugin as openaiAuth } from "./openai/index.js";
export { opencodeZenServerPlugin, zenUsageTracker } from "./opencode-zen/index.js";
export { managerRouterHooks } from "./router/index.js";
export { ANTIGRAVITY_ENTRY, PLUGIN_ALIASES, PLUGIN_ID } from "./shared/constants.js";
