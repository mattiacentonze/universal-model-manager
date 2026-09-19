export const PLUGIN_ID = "universal-model-manager";
/** Backwards-compatible aliases for the single-package composite plugin. */
export const PLUGIN_ALIASES = [
  "universal-model-manager",
  "opencode-universal-model-manager",
  "opencode-universal-auth",
];
/** The antigravity auth entrypoint lives on `/antigravity` of the same package. */
export const ANTIGRAVITY_ENTRY = `${PLUGIN_ID}/antigravity`;
export const TUI_ENTRY = PLUGIN_ID;
export const BRIDGE_PORT = 17842;
