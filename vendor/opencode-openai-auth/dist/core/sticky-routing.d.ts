import { type AccountQuota, type QuotaWindow, type QuotaWindowKey } from '../sidebar-state';
export declare const QUOTA_STALENESS_MS: number;
export declare const MIN_RESET_HOURS: number;
export declare const MIN_WEIGHT = 0.000001;
export declare function snapshotCheckedAt(quota: AccountQuota | null | undefined, entryCheckedAt?: number): number | undefined;
export type StickyBreakDecision = {
    action: 'retain';
    reason: 'unknown' | 'stale' | 'healthy' | 'transient';
} | {
    action: 'migrate';
    reason: 'exhausted' | 'permanent' | 'killswitch';
    windowKey?: QuotaWindowKey;
    resetsAt?: string;
};
export declare function decideStickyBreak(input: {
    quota: AccountQuota | null | undefined;
    quotaCheckedAt?: number;
    status?: number;
    now: number;
    killswitchPasses?: boolean;
}): StickyBreakDecision;
export declare function sustainableWindowWeight(window: Pick<QuotaWindow, 'remainingPercent' | 'resetsAt'>, reservePercent: number, now: number): number;
export interface StickySelectionCandidate {
    accountId: string;
    quota: AccountQuota | null | undefined;
    quotaCheckedAt?: number;
    reservePercent: Record<QuotaWindowKey, number>;
    configuredOrder: number;
    resetCreditsApplicable?: number;
    killswitchPasses?: boolean;
}
export interface StickySelectionInput {
    candidates: readonly StickySelectionCandidate[];
    pendingBytes: ReadonlyMap<string, number>;
    requestBytes: number;
    now: number;
    onEmptyWeightedSet?: () => void;
}
export declare function selectStickyCandidate(input: StickySelectionInput): {
    accountId: string;
    quotaCheckedAt?: number;
    source: 'weighted' | 'mode-fallback';
} | undefined;
