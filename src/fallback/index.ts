import type { Plugin } from "@opencode-ai/plugin";
// @ts-ignore
import fallbackPkg from "opencode-runtime-fallback";

export const fallbackPlugin: Plugin = async (input, options) => {
  const pkg: any = fallbackPkg;
  const pluginFn = typeof pkg === "function" ? pkg : pkg?.default;
  if (typeof pluginFn !== "function") {
    throw new Error("Could not initialize runtime fallback engine from opencode-runtime-fallback");
  }
  return pluginFn(input, options);
};

export default {
  id: "universal-runtime-fallback",
  server: fallbackPlugin,
};
