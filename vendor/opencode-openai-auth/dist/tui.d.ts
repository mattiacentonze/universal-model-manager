/** @jsxImportSource @opentui/solid */
import type { TuiPluginModule } from '@opencode-ai/plugin/tui';
import type { ApplyRequest, CommandModalName } from './rpc/protocol.js';
import { type AccountQuota, type QuotaPacing, type QuotaWindow, type SidebarState } from './sidebar-state.js';
export declare function buildApplyRequest(command: CommandModalName, arguments_: string, sessionId?: string): ApplyRequest;
type Tone = 'ok' | 'warn' | 'err' | 'muted' | 'accent' | 'text';
export declare function formatResetIn(resetsAt: string | undefined): string;
export interface QuotaDisplayRow {
    key: 'primary' | 'secondary';
    label: string;
    window: QuotaWindow;
    pacing: QuotaPacing | null;
}
export declare function buildQuotaRowsForDisplay(quota: AccountQuota | null, now: number, pacingEnabled: boolean): QuotaDisplayRow[];
export declare function isQuotaLoaded(quota: AccountQuota | null): boolean;
export declare function getQuotaMetadataRows(state: SidebarState): Array<{
    label: string;
    value: string;
}>;
export declare function getAccountMetadataRows(resetCredits: number | undefined): Array<{
    label: string;
    value: string;
}>;
export declare function readStateFromFile(): Promise<SidebarState>;
export declare function resolveQuotaDialogActiveId(state: SidebarState, sessionId: string | undefined, now?: number): string | undefined;
export interface RoutingDisplayRow {
    label: string;
    value: string;
    tone: Tone;
}
export declare function buildRoutingRowsForDisplay(state: SidebarState, sessionId: string | undefined, now?: number): RoutingDisplayRow[];
declare const plugin: TuiPluginModule & {
    id: string;
};
export default plugin;
