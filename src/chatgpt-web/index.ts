import type { Plugin } from "@opencode-ai/plugin";
import { BridgeServer } from "./bridge-server.js";
import { BrowserManager } from "./browser-manager.js";
import { ChatGptRunner } from "./chatgpt-runner.js";
import { SessionStore } from "./session-store.js";
import { importFromChromeProfile, listChromeProfiles } from "./chrome-importer.js";
import { logger } from "../shared/logger.js";
import { loadConfig, saveConfig } from "../manager/store.js";
import { getOpenCodeConfigDir, getUniversalAuthDataDir } from "../shared/paths.js";

let activeServer: BridgeServer | null = null;

function registerChatGptWebAccount(sessionStore: SessionStore): void {
  const info = sessionStore.getAccountInfo();
  const alias = info?.email?.split("@")[0] || info?.name?.split(" ")[0]?.toLowerCase() || "chatgpt-web";
  const dir = getUniversalAuthDataDir();
  const configDir = getOpenCodeConfigDir();
  const cfg = loadConfig(dir, configDir);
  const existing = cfg.accounts.find(a => a.kind === "chatgpt-web");
  if (existing) {
    existing.alias = alias;
    existing.configured = true;
  } else {
    cfg.accounts.push({
      id: `chatgpt-web-${alias}`,
      kind: "chatgpt-web",
      label: "ChatGPT Web",
      alias,
      main: false,
      configured: true,
    });
  }
  saveConfig(cfg, dir);
}

export async function getOrStartBridgeServer(port = 17842): Promise<BridgeServer | null> {
  if (activeServer) return activeServer;

  const sessionStore = new SessionStore();
  const browserManager = new BrowserManager(sessionStore);
  const runner = new ChatGptRunner(browserManager);

  const server = new BridgeServer({ port, runner, sessionStore });
  try {
    await server.start();
    activeServer = server;
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      logger.info(`Bridge port ${port} already bound by another daemon process.`);
    } else {
      throw err;
    }
  }
  return activeServer;
}

async function isDaemonUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export const chatgptWebServerPlugin: Plugin = async (input, options) => {
  const port = typeof options?.port === "number" ? options.port : 17842;
  const sessionStore = new SessionStore();

  // Prefer a shared external daemon on the port; only start an in-process bridge
  // as a fallback when no daemon is reachable. This lets many opencode sessions
  // share one ChatGPT Web bridge without fighting over the port.
  const tryStart = async (): Promise<void> => {
    if (await isDaemonUp(port)) return;
    try {
      await getOrStartBridgeServer(port);
    } catch (err) {
      logger.warn(`Could not start bridge server automatically: ${err}`);
    }
  };
  void tryStart();
  const retryTimer = setInterval(() => {
    if (!activeServer && !isDaemonUp(port)) void tryStart();
  }, 15_000);
  retryTimer.unref?.();

  return {
    config: async (cfg: any) => {
      // Register custom slash commands
      if (!cfg.command) cfg.command = {};
      cfg.command["universal-chatgpt-web"] = {
        description: "Manage ChatGPT Web authentication and bridge status",
        template: "Command executed for ChatGPT Web management: $ARGUMENTS",
      };
    },

    "command.execute.before": async (data, output) => {
      if (data.command !== "universal-chatgpt-web") return;

      const args = (data.arguments || "").trim().split(/\s+/);
      const sub = args[0] || "status";

      if (sub === "status") {
        const hasSession = sessionStore.hasValidSession();
        const info = sessionStore.getAccountInfo();
        const accountLabel = info?.name ? ` (Account: ${info.name})` : "";
        output.parts.push({
          type: "text",
          text: `[Universal Auth] ChatGPT Web Status:\n- Session logged in: ${hasSession ? "YES" + accountLabel : "NO"}\n- Bridge endpoint: http://127.0.0.1:${port}/v1\n- Models: chatgpt-web/auto, chatgpt-web/pro, chatgpt-web/think, chatgpt-web/luna`,
        } as any);
        return;
      }

      if (sub === "profiles" || sub === "list") {
        const profiles = listChromeProfiles();
        const currentInfo = sessionStore.getAccountInfo();
        let msg = "[Universal Auth] Available Google Chrome Profiles:\n";
        profiles.forEach((p, i) => {
          const isCurrent = Boolean(
            currentInfo?.name && (
              currentInfo.name.includes(p.email || "___") ||
              currentInfo.name.includes(p.folder)
            )
          );
          const status = p.hasSession ? "ChatGPT ACTIVE" : "No ChatGPT session";
          msg += `  ${i + 1}. [${p.folder}] ${p.name} (${p.email || "no email"}) — ${status}${isCurrent ? " <- ACTIVE" : ""}\n`;
        });
        msg += "\nTo connect an account, run:\n  /universal-chatgpt-web login <number or name>\n  Example: /universal-chatgpt-web login 1  OR  /universal-chatgpt-web login iit";
        output.parts.push({ type: "text", text: msg } as any);
        return;
      }

      if (sub === "login" || sub === "import" || sub === "switch") {
        const target = args[1]; // e.g. "1", "2", "iit", "personal", "Default", "Profile 3"
        const profiles = listChromeProfiles();

        if (target) {
          let targetFolder = target;
          const idx = parseInt(target, 10);
          if (!isNaN(idx) && idx >= 1 && idx <= profiles.length) {
            targetFolder = profiles[idx - 1].folder;
          }

          const res = importFromChromeProfile(targetFolder, sessionStore);
          if (res.ok) {
            registerChatGptWebAccount(sessionStore);
            output.parts.push({
              type: "text",
              text: `[Universal Auth] Connected to Chrome profile: ${res.profile ? `${res.profile.name} (${res.profile.email})` : targetFolder}. ChatGPT Web is active and ready!`,
            } as any);
            return;
          } else {
            output.parts.push({
              type: "text",
              text: `[Universal Auth] Could not import session for "${target}": ${res.error || "No active session in that profile"}.\nRun /universal-chatgpt-web profiles to view all options.`,
            } as any);
            return;
          }
        }

        // No argument: check if multiple profiles have ChatGPT sessions
        const withSessions = profiles.filter(p => p.hasSession);
        if (withSessions.length > 1) {
          let msg = `[Universal Auth] Multiple Chrome profiles with active ChatGPT sessions detected:\n`;
          profiles.forEach((p, i) => {
            const status = p.hasSession ? "ChatGPT ACTIVE" : "No session";
            msg += `  ${i + 1}. ${p.name} (${p.email || p.folder}) — ${status}\n`;
          });
          msg += `\nRun /universal-chatgpt-web login <number> to select, e.g.:\n  /universal-chatgpt-web login 1  (for ${profiles[0]?.name || "Profile 1"})\n  /universal-chatgpt-web login 2  (for ${profiles[1]?.name || "Profile 2"})`;
          output.parts.push({ type: "text", text: msg } as any);
          return;
        }

        // Exactly one or default
        const defaultTarget = withSessions[0]?.folder || "Default";
        const res = importFromChromeProfile(defaultTarget, sessionStore);
        if (res.ok) {
          registerChatGptWebAccount(sessionStore);
          output.parts.push({
            type: "text",
            text: `[Universal Auth] Login successful! Connected to Chrome profile: ${res.profile?.name} (${res.profile?.email}). Ready to use!`,
          } as any);
          return;
        }

        output.parts.push({
          type: "text",
          text: "[Universal Auth] No active session found in Chrome. Opening login window...",
        } as any);

        const bm = new BrowserManager(sessionStore);
        const ok = await bm.launchInteractiveLogin();
        if (ok) registerChatGptWebAccount(sessionStore);
        const info = sessionStore.getAccountInfo();
        const accountLabel = info?.name ? ` for ${info.name}` : "";
        output.parts.push({
          type: "text",
          text: ok
            ? `[Universal Auth] Login successful! Session captured${accountLabel} and ready to use.`
            : "[Universal Auth] Login was not completed. Run /universal-chatgpt-web login again.",
        } as any);
        return;
      }

      output.parts.push({
        type: "text",
        text: `Usage:\n  /universal-chatgpt-web status             (Check connection status)\n  /universal-chatgpt-web profiles           (List Chrome profiles)\n  /universal-chatgpt-web login <number>     (Switch to chosen Chrome profile)`,
      } as any);
    },
  };
};

export default {
  id: "universal-chatgpt-web",
  server: chatgptWebServerPlugin,
};
