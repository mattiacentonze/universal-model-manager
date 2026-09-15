export interface QuotaWindow {
    usedPercent: number;
    remainingPercent: number;
    checkedAt?: number;
    resetsAt?: string;
    windowMinutes?: number;
}
export interface AccountQuota {
    checkedAt?: number;
    primary?: QuotaWindow;
    secondary?: QuotaWindow;
    resetCreditsAvailable?: number;
}
export type QuotaWindowKey = 'primary' | 'secondary';
export declare function formatWindowLabel(windowMinutes: number | undefined, fallbackKey: QuotaWindowKey): string;
export interface PresentQuotaWindow {
    key: QuotaWindowKey;
    label: string;
    window: QuotaWindow;
    windowMs: number | null;
}
export declare function getPresentQuotaWindows(quota: AccountQuota | null): PresentQuotaWindow[];
export interface SidebarAccountState {
    id: string;
    label: string | undefined;
    /** ChatGPT identity of the account this quota belongs to. */
    accountId?: string;
    quota: AccountQuota | null;
    killed: boolean;
    enabled: boolean;
    resetCredits?: number;
}
export interface ActiveRoutingEntry {
    activeId: string;
    route: string;
    updatedAt: number;
}
export type ActiveRoutingMap = Record<string, ActiveRoutingEntry>;
export interface StickyAssignment {
    accountId: string;
    wireAccountId?: string;
    assignedAt: number;
    lastSeenAt: number;
    inputBytes: number;
    quotaCheckedAt?: number;
}
export type StickyAssignmentMap = Record<string, StickyAssignment>;
export interface StickyAssignmentChoice {
    accountId: string;
    quotaCheckedAt?: number;
}
export interface ResolveStickyAssignmentInput {
    sessionId: string;
    requestBytes: number;
    now: number;
    validPinnedAccountIds: readonly string[];
    excludeAccountIds?: readonly string[];
    quotaCheckedAtByAccount: Readonly<Record<string, number | undefined>>;
    wireAccountIdByAccount?: Readonly<Record<string, string | undefined>>;
    choose: (pendingBytes: ReadonlyMap<string, number>) => StickyAssignmentChoice | undefined;
}
export interface SidebarState {
    main: {
        quota: AccountQuota | null;
        /** ChatGPT identity of the main account this quota belongs to. */
        mainAccountId?: string;
        killed: boolean;
        quotaBackedOff?: boolean;
        quotaBackoffUntil?: number;
        refreshBackedOff?: boolean;
        refreshBackoffUntil?: number;
        resetCredits?: number;
    };
    fallbacks: SidebarAccountState[];
    /** @deprecated Compatibility field for readers that do not consume activeRouting. */
    activeId: string | undefined;
    /** Machine-global routing mode and compatibility value for older readers. */
    route: string;
    activeRouting?: ActiveRoutingMap;
    stickyAssignments?: StickyAssignmentMap;
    planType?: string;
    credits?: number;
    lastUpdated: number;
}
export declare const STICKY_ASSIGNMENT_MAX_AGE_MS: number;
export declare const STICKY_ASSIGNMENT_MAX_ENTRIES = 256;
export declare function hashSidebarSessionId(sessionId: string): string;
export declare function getSidebarStateFile(): string;
export declare const DEFAULT_SIDEBAR_STATE: SidebarState;
/**
 * Normalize an arbitrary parsed value into a well-formed SidebarState.
 *
 * JSON.parse + `as SidebarState` is an unchecked cast — a partial, old, or
 * malformed state file passes through and the TUI's `state().main.quota` /
 * `state().fallbacks.filter(...)` throw at runtime. This helper guarantees
 * every required field is present and correctly typed before the value leaves
 * the I/O boundary, so a bad file can never crash the host TUI.
 */
export declare function normalizeSidebarState(raw: unknown): SidebarState;
export declare function getSidebarState(stateFile?: string): Promise<SidebarState>;
export declare const ACTIVE_ROUTING_MAX_AGE_MS: number;
export declare const ACTIVE_ROUTING_MAX_ENTRIES = 128;
export type SidebarRoutingAccount = {
    id: string;
    enabled?: boolean;
    killed?: boolean;
};
export declare function isUsableRoutingEntry(entry: ActiveRoutingEntry, accounts: readonly SidebarRoutingAccount[] | undefined, now?: number): boolean;
export declare function exhaustedQuotaResetAt(quota: AccountQuota | null | undefined, now?: number): {
    resetsAt: string;
    resetAtMs: number;
} | undefined;
export declare function isQuotaExhausted(quota: AccountQuota | null | undefined, now?: number): boolean;
export declare function resolveSessionStickyAccount(state: SidebarState, sessionId: string | undefined, now?: number): string | undefined;
export declare function resolveSessionSidebarRouting(state: SidebarState, sessionId?: string, now?: number): {
    activeId: string;
    route: string;
};
export declare function pruneActiveRouting(activeRouting: ActiveRoutingMap | undefined, accounts: readonly SidebarRoutingAccount[] | undefined, now?: number, removedSessionId?: string): ActiveRoutingMap | undefined;
export declare function pruneStickyAssignments(assignments: StickyAssignmentMap | undefined, validAccountIds: ReadonlySet<string> | undefined, now?: number, removedSessionHash?: string): StickyAssignmentMap | undefined;
interface SidebarMergeHooks {
    beforeRecheck?: () => void | Promise<void>;
}
/**
 * Write sidebar state to disk, serialized through a promise chain so
 * concurrent callers never interleave or let a stale write land last.
 *
 * @param state  The state to persist.
 * @param file   Explicit path override — callers that bind the path at init
 *               time (e.g. the index.ts loader) pass this so late callbacks
 *               always write to the path that was current when the loader ran,
 *               even if the env changes underneath them during tests.
 *               Defaults to getSidebarStateFile() (per-call resolution).
 */
export declare function setSidebarState(state: SidebarState, file?: string): Promise<void>;
export type SidebarMachineState = Pick<SidebarState, 'main' | 'fallbacks' | 'planType' | 'credits' | 'lastUpdated'> & {
    route: string;
};
export declare function setSidebarMachineState(machineState: SidebarMachineState, file?: string, hooks?: SidebarMergeHooks): Promise<void>;
export declare function upsertSidebarActiveRouting(input: {
    sessionId: string;
} & ActiveRoutingEntry, accounts: readonly SidebarRoutingAccount[] | undefined, file?: string, hooks?: SidebarMergeHooks): Promise<void>;
export declare function setSidebarLegacyRouting(input: ActiveRoutingEntry, file?: string): Promise<void>;
export declare function removeSidebarActiveRouting(sessionId: string, accounts: readonly SidebarRoutingAccount[] | undefined, file?: string, hooks?: SidebarMergeHooks): Promise<void>;
export declare function resolveSidebarStickyAssignment(input: ResolveStickyAssignmentInput, file?: string, hooks?: SidebarMergeHooks): Promise<StickyAssignment | undefined>;
export declare function clearSidebarStickyAssignment(sessionId: string, file?: string): Promise<boolean>;
/**
 * Await all pending sidebar writes. Tests call this before restoring env
 * vars in teardown so no in-flight write can re-resolve getSidebarStateFile()
 * after the env is changed.
 */
export declare function drainSidebarWrites(): Promise<void>;
export declare function resolveActiveAccount(state: SidebarState): {
    id: string;
    name: string;
    quota: AccountQuota | null;
    killed: boolean;
};
export declare function getCollapsedQuotaSummary(quota: AccountQuota | null): {
    primaryUsedPercent: number | null;
    secondaryUsedPercent: number | null;
    text: string | null;
};
export interface QuotaPacing {
    pacePercent: number;
    deltaPercent: number;
    state: 'deficit' | 'reserve' | 'on-pace';
    runsOutAt: string | null;
}
export declare function computeQuotaPacing(window: QuotaWindow, windowMs: number, now: number): QuotaPacing | null;
export {};
