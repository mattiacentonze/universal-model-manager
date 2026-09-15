import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui";
import { openWizard, accountsSettings, routerSettings, showReset } from "./tui/dialogs.js";
import { getOpenCodeConfigDir } from "./shared/paths.js";
import { loadConfig, summarize } from "./manager/index.js";
import { ModelManagerSidebar } from "./tui/sidebar-widget.js";

type Api = TuiPluginApi;
const configDir = () => getOpenCodeConfigDir();

/** Unified right-column sidebar widget rendered as a real terminal element. */
function sidebarWidget(api: Api) {
  if (api.slots && typeof api.slots.register === "function") {
    api.slots.register({
      order: 100,
      slots: {
        sidebar_content(_context: unknown, props: { session_id?: string } = {}) {
          return <ModelManagerSidebar api={api} sessionId={props?.session_id} />;
        },
      },
    });
  }
}

export const tui: TuiPlugin = async (api, options, meta) => {
  // 1. Unified MODEL MANAGER sidebar widget (owns the right column).
  sidebarWidget(api);

  // 2. Summary route.
  if (api.route) {
    api.route.register([
      {
        name: "model-manager-summary",
        render: () => <text>{summarize(loadConfig(undefined, configDir()), configDir())}</text>,
      },
    ]);
  }

  // 3. Consolidated essential slash commands and interactive dialogs.
  if (api.command && typeof api.command.register === "function") {
    api.command.register(() => [
      {
        title: "/fallback-list",
        value: "model-manager.slash.fallback-list",
        description: "Configure router, orchestrator & per-tier fallback chains",
        category: "model-manager",
        slash: { name: "fallback-list", aliases: ["u-fallbacks"] },
        onSelect: () => routerSettings(api),
      },
      {
        title: "/accounts",
        value: "model-manager.slash.accounts",
        description: "Manage Google & OpenAI accounts, aliases, and routing modes",
        category: "model-manager",
        slash: { name: "accounts", aliases: ["u-accounts"] },
        onSelect: () => accountsSettings(api),
      },
      {
        title: "/setup",
        value: "model-manager.slash.setup",
        description: "Setup wizard (accounts, tiers, router)",
        category: "model-manager",
        slash: { name: "setup", aliases: ["u-setup"] },
        onSelect: () => openWizard(api),
      },
      {
        title: "/reset",
        value: "model-manager.slash.reset",
        description: "Reset manager config & wizard",
        category: "model-manager",
        slash: { name: "reset", aliases: ["u-reset"] },
        onSelect: () => showReset(api),
      },
    ]);
  }
};

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-universal-model-manager-tui",
  tui,
};

export default plugin;
