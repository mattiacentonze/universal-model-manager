export interface ChatGptWebModelDef {
  id: string;
  name: string;
  description: string;
  effort?: "low" | "medium" | "high" | "max";
  requiresPro?: boolean;
}

export const CHATGPT_WEB_MODELS: Record<string, ChatGptWebModelDef> = {
  "chatgpt-web/auto": {
    id: "chatgpt-web/auto",
    name: "ChatGPT Web (Auto)",
    description: "Automatic ChatGPT Web model selection based on account capability",
    effort: "medium",
  },
  "chatgpt-web/instant": {
    id: "chatgpt-web/instant",
    name: "ChatGPT Web (Instant)",
    description: "Fast reasoning / instant responses via ChatGPT Web",
    effort: "low",
  },
  "chatgpt-web/think": {
    id: "chatgpt-web/think",
    name: "ChatGPT Web (Think)",
    description: "Deep thinking mode via ChatGPT Web",
    effort: "high",
  },
  "chatgpt-web/pro": {
    id: "chatgpt-web/pro",
    name: "ChatGPT Web (Pro)",
    description: "ChatGPT Pro max effort reasoning",
    effort: "max",
    requiresPro: true,
  },
  "chatgpt-web/luna": {
    id: "chatgpt-web/luna",
    name: "ChatGPT Web (Luna)",
    description: "Free / Go tier ChatGPT Web model",
    effort: "low",
  },
};
