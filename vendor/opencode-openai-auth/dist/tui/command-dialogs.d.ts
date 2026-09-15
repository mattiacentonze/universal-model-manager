/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import type { OpenDialogPayload } from '../rpc/protocol.js';
import { type AccountQuota, type SidebarState } from '../sidebar-state.js';
type ApplyFn = (command: OpenDialogPayload['command'], args: string) => Promise<{
    text: string;
    knobs: Record<string, unknown>;
}>;
export declare function buildCachekeepDialogOptions(payload: OpenDialogPayload): {
    title: string;
    value: string;
    description: string;
}[];
export declare function openCommandDialog(api: TuiPluginApi, payload: OpenDialogPayload, apply: ApplyFn, sessionId?: string): void;
export declare function formatQuotaWindows(quota: AccountQuota | null | undefined): string;
export declare function buildAccountDialogRows(state: SidebarState, sessionId?: string): {
    title: string;
    value: string;
    description: string;
}[];
export {};
