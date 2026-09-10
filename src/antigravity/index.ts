import type { Plugin } from "@opencode-ai/plugin";
// @ts-ignore
import { GoogleOAuthPlugin, AntigravityCLIOAuthPlugin } from "@cortexkit/opencode-antigravity-auth";

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
