import type { Plugin } from "@opencode-ai/plugin";
import { zenUsageTracker } from "./usage-tracker.js";

export const opencodeZenServerPlugin: Plugin = async (_input, _options) => {
  return {
    event: async ({ event }) => {
      try {
        const type = (event as any)?.type as string;
        const props = (event as any)?.properties;
        if (type === "message.updated" || type === "message.created") {
          const info = props?.info;
          if (info && info.role === "assistant") {
            const providerID = info.providerID || info.model?.providerID;
            const modelID = typeof info.model === "string" ? info.model : info.modelID || info.model?.modelID;
            const isZen =
              providerID === "opencode" ||
              (typeof modelID === "string" && (modelID.startsWith("opencode/") || modelID.includes("big-pickle")));
            if (isZen) {
              const tokens = info.tokens;
              if (tokens && typeof tokens === "object") {
                const input = Number(tokens.input ?? tokens.prompt ?? 0);
                const output = Number(tokens.output ?? tokens.completion ?? 0);
                if (input > 0 || output > 0) {
                  zenUsageTracker.recordUsage(input, output);
                }
              }
            }
          }
        } else if (type === "session.status") {
          const status = props?.status;
          if (status?.type === "retry") {
            const agent = props?.agent;
            if (typeof status.next === "number" && status.next > Date.now()) {
              zenUsageTracker.recordRateLimit(status.next, status.message);
            }
          }
        }
      } catch {
        // Ignored
      }
    },
  };
};

export { zenUsageTracker, ZenUsageTracker } from "./usage-tracker.js";
export default {
  id: "universal-opencode-zen",
  server: opencodeZenServerPlugin,
};
