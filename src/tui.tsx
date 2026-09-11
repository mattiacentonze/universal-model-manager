import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui";
import { usageTracker } from "./chatgpt-web/usage-tracker.js";
import { nextMissingStep, stepLabel } from "./tui/wizard-core.js";
import { openWizard, accountsSettings, routerSettings, showReset } from "./tui/dialogs.js";
import { providerConfigured } from "./manager/auth-status.js";
import { getOpenCodeConfigDir } from "./shared/paths.js";
import { loadConfig, summarize } from "./manager/index.js";

type Api = TuiPluginApi;
const configDir = () => getOpenCodeConfigDir();

/** Unified sidebar widget rendered as a real terminal element (not a string). */
function sidebarWidget(api: Api) {
  if (api.slots && typeof api.slots.register === "function") {
    api.slots.register({
      order: 340,
      slots: {
        sidebar_content() {
          const step = nextMissingStep(loadConfig(undefined, configDir()), configDir());
          const oa = providerConfigured("openai", configDir());
          const ag = providerConfigured("antigravity", configDir());
          return (
            <box>
              <text>Model Manager</text>
              <text>OpenAI: {oa ? "configured" : "pending"}</text>
              <text>Antigravity: {ag ? "configured" : "pending"}</text>
              <text>ChatGPT Web: {usageTracker.getStatus().isLoggedIn ? "Active" : "Logged Out"}</text>
              <text>Wizard: {step === null ? "complete" : stepLabel(step)}</text>
            </box>
          );
        },
      },
    });
  }
}

export const tui: TuiPlugin = async (api, options, meta) => {
  // 1. Delegate to CortexKit OpenAI TUI widget (native account dialogs) if present.
  try {
    const openaiTui = await import("@cortexkit/opencode-openai-auth/tui");
    if (openaiTui?.default?.tui) await openaiTui.default.tui(api, options, meta);
  } catch { /* optional */ }

  // 2. Delegate to Antigravity TUI widget (native credits widget) if present.
  try {
    const antigravityTui = await import("@cortexkit/opencode-antigravity-auth/tui");
    if (antigravityTui?.default?.tui) await antigravityTui.default.tui(api, options, meta);
  } catch { /* optional */ }

  // 3. Unified sidebar widget (preserved alongside CortexKit widgets).
  sidebarWidget(api);

  // 4. Summary route.
  if (api.route) {
    api.route.register([
      {
        name: "model-manager-summary",
        render: () => <text>{summarize(loadConfig(undefined, configDir()), configDir())}</text>,
      },
    ]);
  }

  // 5. Command palette + real slash registrations + interactive dialogs.
  if (api.command && typeof api.command.register === "function") {
    api.command.register(() => {
      const step = nextMissingStep(loadConfig(undefined, configDir()), configDir());
      return [
        { title: step === null ? "Model Manager setup complete" : `Resume Model Manager setup (${stepLabel(step)})`, value: "model-manager.wizard.resume", description: step === null ? "All valid" : "Continue from next missing setting", category: "model-manager", suggested: step !== null, onSelect: () => openWizard(api) },
        { title: "Manage provider accounts", value: "model-manager.accounts", description: "Select main / login per provider via native commands", category: "model-manager", onSelect: () => accountsSettings(api) },
        { title: "Router settings", value: "model-manager.router", description: "Toggle, orchestrator, per-tier chains", category: "model-manager", onSelect: () => routerSettings(api) },
        { title: "Reset manager config (confirmed)", value: "model-manager.reset", description: "Reset manager config & wizard, keeping credentials", category: "model-manager", onSelect: () => showReset(api) },
        // Slash-registered aliases so real `/u-*` commands surface in the TUI.
        // Must NOT be `hidden`: the host filters hidden commands out of the
        // palette, which would make `/u-setup` & co. resolve to "No matching
        // items" and shadow the dialogs entirely.
        { title: "/u-setup", value: "model-manager.slash.u-setup", description: "Resume setup wizard", category: "model-manager", slash: { name: "u-setup" }, onSelect: () => openWizard(api) },
        { title: "/u-wizard", value: "model-manager.slash.u-wizard", description: "Resume setup wizard", category: "model-manager", slash: { name: "u-wizard" }, onSelect: () => openWizard(api) },
        { title: "/u-accounts", value: "model-manager.slash.u-accounts", description: "Manage provider accounts", category: "model-manager", slash: { name: "u-accounts" }, onSelect: () => accountsSettings(api) },
        { title: "/u-main", value: "model-manager.slash.u-main", description: "Select main account", category: "model-manager", slash: { name: "u-main" }, onSelect: () => accountsSettings(api) },
        { title: "/u-fallbacks", value: "model-manager.slash.u-fallbacks", description: "Per-tier fallback chains", category: "model-manager", slash: { name: "u-fallbacks" }, onSelect: () => routerSettings(api) },
        { title: "/u-router", value: "model-manager.slash.u-router", description: "Router settings", category: "model-manager", slash: { name: "u-router" }, onSelect: () => routerSettings(api) },
        { title: "/u-reset", value: "model-manager.slash.u-reset", description: "Reset manager config & wizard", category: "model-manager", slash: { name: "u-reset" }, onSelect: () => showReset(api) },
      ];
    });
  }
};

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-universal-model-manager-tui",
  tui,
};

export default plugin;
