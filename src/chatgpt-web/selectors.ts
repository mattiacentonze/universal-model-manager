export const CHATGPT_BASE_URL = "https://chatgpt.com";
export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";

export const SELECTORS = {
  composer: [
    "#prompt-textarea",
    '[data-testid="prompt-textarea"]',
    '[contenteditable="true"][data-lexical-editor="true"]',
    'textarea[placeholder*="Ask"]',
  ].join(", "),

  stopButton: [
    '[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
  ].join(", "),

  sendButton: [
    '[data-testid="send-button"]',
    'button[data-testid="fruitjuice-send-button"]',
    'button[aria-label="Send prompt"]',
  ].join(", "),

  assistantTurn: [
    '[data-testid^="conversation-turn-"][data-turn="assistant"]',
    '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
    '[data-message-author-role="assistant"]',
    "div[data-message-model-slug]",
  ].join(", "),

  copyButton: ['button[data-testid="copy-turn-action-button"]', 'button[aria-label="Copy"]'].join(", "),

  effortButton: [
    'button[aria-haspopup="menu"][data-tone="neutral"]',
    'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
  ].join(", "),

  profileButton: [
    '[data-testid="profile-button"]',
    'button[aria-label*="User profile"]',
    'button[aria-label*="Account"]',
    '[data-testid="user-menu"]',
  ].join(", "),

  effortSlider: '[data-model-reasoning-effort-slider] [role="slider"]',
};
