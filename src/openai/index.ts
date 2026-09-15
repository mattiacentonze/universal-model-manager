import type { Plugin } from "@opencode-ai/plugin";

// Vendored cortexkit OpenAI auth plugin (compiled bundle lives in vendor/).
// @ts-ignore
import cortexkitPkg from "../../vendor/opencode-openai-auth/dist/index.js";

export const openaiServerPlugin: Plugin = async (input, options) => {
  const pkg: any = cortexkitPkg;
  if (pkg && typeof pkg.server === "function") {
    return pkg.server(input, options);
  }
  if (typeof pkg === "function") {
    return pkg(input, options);
  }
  if (pkg && typeof pkg.CodexAuthPlugin === "function") {
    return pkg.CodexAuthPlugin(input, options);
  }
  throw new Error("Could not initialize OpenAI auth plugin from @cortexkit/opencode-openai-auth");
};

export default {
  id: "universal-openai-auth",
  server: openaiServerPlugin,
};
