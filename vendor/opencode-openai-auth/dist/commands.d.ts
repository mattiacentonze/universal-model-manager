import { type loadAccounts as defaultLoadAccounts } from './core/accounts';
import type { CacheKeepManager, CacheKeepWindow } from './core/cachekeep';
import type { QuotaManager } from './core/quota-manager';
import type { RefreshAllQuotaResult } from './core/refresh-all-quota';
import { type RunResetCreditResult } from './core/reset-credits';
import type { ApplyRequest, ApplyResult, CommandModalName, OpenDialogPayload } from './rpc/protocol';
export declare const OPENAI_QUOTA_COMMAND_NAME = "openai-quota";
export declare const OPENAI_ACCOUNT_COMMAND_NAME = "openai-account";
export declare const OPENAI_ROUTING_COMMAND_NAME = "openai-routing";
export declare const OPENAI_KILLSWITCH_COMMAND_NAME = "openai-killswitch";
export declare const OPENAI_DUMP_COMMAND_NAME = "openai-dump";
export declare const OPENAI_LOGGING_COMMAND_NAME = "openai-logging";
export declare const OPENAI_CACHEKEEP_COMMAND_NAME = "openai-cachekeep";
export declare const OPENAI_RESET_COMMAND_NAME = "openai-reset";
export declare const MODAL_COMMANDS: CommandModalName[];
export interface CommandContext {
    accountStoragePath: string;
    quotaManager: QuotaManager;
    loadAccounts: typeof defaultLoadAccounts;
    client: {
        auth: {
            set: (input: {
                path: {
                    id: string;
                };
                body: {
                    type: string;
                    access?: string;
                    refresh: string;
                    expires?: number;
                };
            }) => Promise<unknown>;
        };
    };
    /** Session ID for pushNotification delivery. */
    sessionId?: string;
    /** If set, pushNotification is wired up and can deliver feedback to the user. */
    notify?: (payload: OpenDialogPayload) => void;
    /** Refresh the sidebar-state file so the TUI modal shows current data. */
    refreshSidebar?: () => Promise<void>;
    /** Actively poll wham/usage for all accounts (main + fallbacks). */
    refreshAllQuota?: () => Promise<RefreshAllQuotaResult[]>;
    /** Prompt-cache cachekeep manager. Set when the command is wired. */
    cacheKeepManager?: CacheKeepManager | null;
    /** Updates the live loader's persisted-enabled cachekeep gate. */
    setCacheKeepEnabled?: (enabled: boolean) => void;
    /** Updates the live loader's persisted-subagent cachekeep gate. */
    setCacheKeepSubagents?: (enabled: boolean) => void;
    /** Updates the live loader's main-agent idle-cap bypass gate. */
    setCacheKeepSustain?: (enabled: boolean) => void;
    /** Updates the live loader's clock-hour warm window. undefined = no window. */
    setCacheKeepWindow?: (window: CacheKeepWindow | undefined) => void;
    /** Clears only the sticky account assignment for one OpenCode session. */
    clearStickyRouting?: (sessionId: string) => Promise<boolean>;
    /** Resolves the current session's usable sticky account, if one exists. */
    getStickyRouting?: (sessionId: string) => Promise<string | undefined>;
    resolveResetTarget?: (accountKey: string) => Promise<ResetTargetIdentity>;
    fetchImpl?: typeof fetch;
    now?: () => number;
    randomUUID?: () => string;
    refreshResetTargetQuota?: (accountKey: string) => Promise<RefreshAllQuotaResult>;
}
export interface ResetTargetIdentity {
    accountKey: string;
    label: string;
    accessToken: string;
    chatgptAccountId?: string;
}
type ResetCommandContext = CommandContext & Required<Pick<CommandContext, 'resolveResetTarget' | 'fetchImpl' | 'now' | 'randomUUID' | 'refreshResetTargetQuota'>>;
export declare function renderResetCoordinatorResult(result: RunResetCreditResult, ctx: ResetCommandContext, boundChatgptAccountId?: string): Promise<OpenDialogPayload>;
/**
 * Strip credential-shaped fields from a dialog payload's knobs.
 *
 * Knobs are returned across the loopback RPC and JSON-serialized to the TUI, so
 * a knob is a published surface. Individual commands project their own knobs
 * deliberately (see accountKnob), but this is the boundary backstop: a future
 * command that returns a stored object directly cannot leak credentials even if
 * the projection is forgotten, because nothing credential-shaped survives here.
 *
 * Scrub rather than throw. A rejected dialog is a visible outage for a live
 * command, while a scrubbed one keeps working with the leak removed; the warning
 * is what gets the projection fixed. Recurses into nested objects and arrays,
 * since the account list arrives as an array of records.
 */
export declare function scrubKnobs(value: unknown, path: string, found: string[]): unknown;
export declare function buildDialogPayload(command: CommandModalName, args: string, ctx: CommandContext): Promise<OpenDialogPayload>;
export declare function applyCommand(request: ApplyRequest, ctx: CommandContext): Promise<ApplyResult>;
export {};
