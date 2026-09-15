/**
 * Slash-command wiring for the antigravity plugin.
 *
 * Three places must agree on the set of modal commands — keeping
 * them in lockstep is a hard invariant:
 *
 *   1. `MODAL_COMMANDS` — the canonical list of `CommandModalName`s.
 *   2. `registerAntigravityCommands` (in `./catalog.ts`) — what we
 *      register in the host `config.command.*` map so OpenCode
 *      recognises them.
 *   3. `buildDialogPayload` (here) — the per-command dialog payload
 *      builder the TUI renders when a notification arrives.
 *
 * If any one drifts, a future slash command will be discoverable in
 * the host palette but invisible to the dialog flow (or vice versa).
 * The bidirectional three-wiring test pins this invariant.
 *
 * `/gemini-dump` remains a backward-compatibility alias: the host
 * already registers the command under that name in `OpenCode` and
 * long-running sessions may still call it. The modal name
 * `antigravity-dump` is the canonical name; both stay registered.
 */
import type { CommandModalName } from '../rpc/protocol';
import type { AccountCommandOAuthService } from './account-command-oauth';
import type { CommandAccountRow, CommandDataService } from './command-data';
import { type OperatorSettingsController } from './operator-settings';
import type { PluginClient, PluginResult } from './types';
export declare const ANTIGRAVITY_QUOTA_COMMAND_NAME = "antigravity-quota";
export declare const ANTIGRAVITY_ACCOUNT_COMMAND_NAME = "antigravity-account";
export declare const ANTIGRAVITY_ROUTING_COMMAND_NAME = "antigravity-routing";
export declare const ANTIGRAVITY_KILLSWITCH_COMMAND_NAME = "antigravity-killswitch";
export declare const ANTIGRAVITY_DUMP_COMMAND_NAME = "antigravity-dump";
export declare const ANTIGRAVITY_LOGGING_COMMAND_NAME = "antigravity-logging";
export declare const MODAL_COMMANDS: readonly CommandModalName[];
interface CommandContext {
    sessionID: string;
    client: PluginClient;
    settings: OperatorSettingsController;
    /**
     * Optional callback invoked AFTER `applyCommand` mutates persistent
     * state. The plugin entry injects a callback that pushes the current
     * account pool into the sidebar so the TUI sees a fresh snapshot.
     * Commands that need to chain side effects (e.g. account add which
     * triggers an OAuth flow) hook their own refresh.
     */
    onApplied?: (accounts?: CommandAccountRow[]) => Promise<void> | void;
    /**
     * Privacy-safe data service that backs the data-first dialogs. The
     * production wiring injects one that reads from the live AccountManager
     * + storage and refreshes through the shared quota manager; tests
     * (and any context that does not care about quota UI) leave this
     * undefined and the dialog falls back to the legacy placeholder.
     */
    commandData?: CommandDataService;
    accountOAuth?: AccountCommandOAuthService;
}
/**
 * Build the dialog payload the TUI renders for `command`.
 *
 * Each branch produces a self-contained payload the OpenTUI dialog tree
 * can mount without further RPC chatter. The knobs object is the
 * payload-specific metadata (current toggle state, available actions,
 * default values) — knobs are intentionally stringly-typed to keep the
 * dialog code free of per-command schema definitions.
 */
export declare function buildDialogPayload(command: CommandModalName, argumentsText: string, context: CommandContext): Promise<{
    command: CommandModalName;
    text: string;
    knobs: Record<string, unknown>;
}>;
export interface ApplyRequest {
    command: CommandModalName;
    arguments: string;
    sessionId?: string;
}
export interface ApplyResult {
    text: string;
    knobs: Record<string, unknown>;
}
/**
 * Apply the result of a TUI dialog back to the plugin runtime.
 *
 * Most commands mutate persistent operator settings (routing toggles,
 * killswitch thresholds, log level). Account add/refresh kicks off the
 * OAuth flow which can take up to two minutes on a fresh login — that
 * path opts into a 120s RPC timeout. Status / toggle paths keep the
 * default 2s timeout.
 *
 * The TUI's imperative dispatcher (`tui/command-dialogs.openCommandDialog`)
 * forwards the apply `options.timeoutMs` knob into the RPC apply call
 * so a long-running path (account add / refresh) can opt in without the
 * dialog layer having to special-case it.
 */
export declare function applyCommand(request: ApplyRequest, context: CommandContext): Promise<ApplyResult>;
/**
 * Build a sidebar refresher bound to the supplied account-snapshot provider.
 * The plugin entry passes `lifecycle.getAccountManager()`'s snapshot getter so
 * every `/antigravity-*` apply that mutates persistent state also bumps the
 * sidebar's `checkedAt`. The refresher is best-effort: a lock-contention
 * error or missing manager is swallowed by the caller.
 */
export declare function createSidebarRefresher(getAccounts: () => Array<{
    index: number;
    label?: string;
    enabled?: boolean;
    coolingDownUntil?: number;
    cachedQuota?: {
        gemini?: {
            remainingFraction?: number;
            resetTime?: string;
        };
        'non-gemini'?: {
            remainingFraction?: number;
            resetTime?: string;
        };
    };
    /** Captured plan tier. Absent when unknown. */
    tier?: {
        id: string;
        capturedAt: number;
    };
}> | null): (accounts?: CommandAccountRow[]) => Promise<void>;
/**
 * Optional handle for the host connection state. Tests inject a stub
 * to force the connected/disconnected branch; production callers let
 * the default fall through to the singleton `isTuiConnected` from
 * `rpc/notifications`, which reports "disconnected" until a TUI drain
 * has landed in the last `CONNECTION_TTL_MS` window.
 */
export interface CommandConnectionState {
    isTuiConnected(sessionId?: string): boolean;
}
/**
 * Hook the host's `command.execute.before` to the modal commands.
 *
 * When a slash command is invoked, we push a notification onto the
 * RPC queue and abort the normal prompt with the same handled
 * sentinel the legacy `/gemini-dump` flow already uses.
 *
 * The `sendIgnoredMessage` fallback only fires when no TUI is
 * listening — the only path that actually consumes the queued
 * message. With a live TUI, push alone is enough; double-sending
 * would otherwise render the command text as a visible chat message
 * alongside the dialog the TUI renders.
 */
export declare function createCommandExecuteBefore(client: PluginClient, settings: OperatorSettingsController, pushNotification: (payload: Awaited<ReturnType<typeof buildDialogPayload>>, sessionId?: string) => void, commandData?: CommandDataService, connectionState?: CommandConnectionState): PluginResult['command.execute.before'];
/**
 * Backward-compat wrapper that constructs a no-settings `command.execute.before`
 * for tests that don't care about the operator settings controller. Production
 * code wires the real controller via `createAntigravityPlugin`.
 */
export declare function createCommandExecuteBeforeForClient(client: PluginClient, commandData?: CommandDataService): PluginResult['command.execute.before'];
export {};
//# sourceMappingURL=commands.d.ts.map