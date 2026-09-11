import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { NativeAction } from "../manager/provider-accounts.js";

/** Resolve the focused session id, if any. */
function currentSessionID(api: TuiPluginApi): string | undefined {
  const cur = api.route?.current;
  if (cur?.name === "session") return (cur.params as { sessionID?: string } | undefined)?.sessionID;
  if (cur?.name === "home") return undefined;
  return undefined;
}

/**
 * Dispatch a real native action (login / set-main / reorder / set-routing)
 * through the SDK. In a session we run the native slash command; from the home
 * (no-session) state we attempt the host TUI command surface and surface the
 * verified terminal argv as a fallback. Never shells out on an untrusted string.
 */
export async function dispatchNative(api: TuiPluginApi, action: NativeAction): Promise<{ ok: boolean; text: string }> {
  const sessionID = currentSessionID(api);
  const command = action.command.replace(/^\//, "");
  try {
    if (sessionID) {
      await api.client.session.command({ sessionID, command, arguments: action.arguments });
      return { ok: true, text: `Dispatched /${command} ${action.arguments}`.trimEnd() };
    }
    // No focused session: try the host TUI command surface, else guide.
    const tui = api.client?.tui as { executeCommand?: (p: { command: string }) => unknown } | undefined;
    if (tui?.executeCommand) {
      await tui.executeCommand({ command: `/${command}` });
      return { ok: true, text: `Triggered /${command}` };
    }
    return {
      ok: false,
      text: `Open a session to run the native command. CLI: ${action.cli?.command || action.command} ${(action.cli?.args || []).join(" ")}`.trim(),
    };
  } catch (err) {
    return {
      ok: false,
      text: `Could not dispatch /${command}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
