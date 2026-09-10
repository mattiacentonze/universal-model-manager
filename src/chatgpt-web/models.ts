export interface ChatGptWebModelDef {
  id: string;
  name: string;
  description: string;
  uiEffortIndex?: number; // 0: Instant, 1: Medium, 2: High, 3: Extra High, 4: Pro
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  requiresPro?: boolean;
}

export const CHATGPT_WEB_MODELS: Record<string, ChatGptWebModelDef> = {
  "chatgpt-web/auto": {
    id: "chatgpt-web/auto",
    name: "ChatGPT Web (Auto - High Reasoning)",
    description: "Automatic Plus/Pro selection, defaults to High reasoning effort",
    uiEffortIndex: 2,
    effort: "high",
  },
  "chatgpt-web/instant": {
    id: "chatgpt-web/instant",
    name: "ChatGPT Web (Instant - Low)",
    description: "Fast responses without deep reasoning",
    uiEffortIndex: 0,
    effort: "low",
  },
  "chatgpt-web/medium": {
    id: "chatgpt-web/medium",
    name: "ChatGPT Web (Medium Reasoning)",
    description: "Balanced reasoning effort",
    uiEffortIndex: 1,
    effort: "medium",
  },
  "chatgpt-web/high": {
    id: "chatgpt-web/high",
    name: "ChatGPT Web (High Reasoning)",
    description: "Deep thinking mode on ChatGPT Plus/Pro",
    uiEffortIndex: 2,
    effort: "high",
  },
  "chatgpt-web/extra-high": {
    id: "chatgpt-web/extra-high",
    name: "ChatGPT Web (Extra High Reasoning)",
    description: "Extended thinking mode for complex architectures",
    uiEffortIndex: 3,
    effort: "xhigh",
  },
  "chatgpt-web/pro": {
    id: "chatgpt-web/pro",
    name: "ChatGPT Web (Pro - Max)",
    description: "ChatGPT Pro maximum thinking effort",
    uiEffortIndex: 4,
    effort: "max",
    requiresPro: true,
  },
  "chatgpt-web/think": {
    id: "chatgpt-web/think",
    name: "ChatGPT Web (Think)",
    description: "Alias for High reasoning effort",
    uiEffortIndex: 2,
    effort: "high",
  },
  "chatgpt-web/luna": {
    id: "chatgpt-web/luna",
    name: "ChatGPT Web (Luna)",
    description: "Free / Go tier fallback without reasoning slider",
    effort: "low",
  },
};

export function resolveEffortIndex(modelId: string): number | undefined {
  const model = CHATGPT_WEB_MODELS[modelId];
  if (model?.uiEffortIndex !== undefined) return model.uiEffortIndex;
  if (modelId.includes("pro")) return 4;
  if (modelId.includes("extra-high") || modelId.includes("xhigh")) return 3;
  if (modelId.includes("high") || modelId.includes("think")) return 2;
  if (modelId.includes("medium")) return 1;
  if (modelId.includes("instant") || modelId.includes("low")) return 0;
  return 2; // Default to High for Plus users
}
