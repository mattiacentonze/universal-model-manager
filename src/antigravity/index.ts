import type { Plugin } from "@opencode-ai/plugin";
// Vendored cortexkit Antigravity auth plugin (compiled bundle lives in vendor/).
// @ts-ignore
import { GoogleOAuthPlugin, AntigravityCLIOAuthPlugin } from "../../vendor/opencode-antigravity-auth/dist/index.js";

export const antigravityServerPlugin: Plugin = async (input, options) => {
  const pluginFn = GoogleOAuthPlugin || AntigravityCLIOAuthPlugin;
  if (typeof pluginFn !== "function") {
    throw new Error("Could not initialize Antigravity auth plugin from @cortexkit/opencode-antigravity-auth");
  }
  return pluginFn(input as any);
};

export default {
  id: "universal-antigravity-auth",
  server: antigravityServerPlugin,
};

export { GoogleOAuthPlugin, AntigravityCLIOAuthPlugin };
