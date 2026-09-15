import { type loadAccounts, type mutateAccounts, type OAuthQuotaSnapshot, type ResetAccountState, type ResetInFlight } from './accounts.ts';
export interface ResetCredit {
    id: string;
    status: string;
    grantedAt?: string;
    expiresAt: string;
    resetType?: string;
    isSupportedByPlan: boolean;
}
export interface ResetCreditList {
    credits: ResetCredit[];
    availableCount?: number;
}
export type ResetConsumeKind = 'reset' | 'already_redeemed' | 'nothing_to_reset' | 'no_credit' | 'http_error' | 'ambiguous';
export interface ResetConsumeOutcome {
    kind: ResetConsumeKind;
    raw: unknown;
    status?: number;
}
export type ResetPrecondition = {
    ok: true;
} | {
    ok: false;
    reason: 'not exhausted';
};
export interface ResetStateDeps {
    configPath: string;
    mutateAccountsFn: typeof mutateAccounts;
    loadAccountsFn: typeof loadAccounts;
    now: () => number;
    randomUUID: () => string;
}
export interface ResetResolvedTarget {
    accountKey: string;
    label: string;
    accessToken: string;
    chatgptAccountId?: string;
}
export interface RunResetCreditDeps extends ResetStateDeps {
    fetchImpl: typeof fetch;
    resolveTarget(accountKey: string): Promise<ResetResolvedTarget>;
    fetchUsage(target: ResetResolvedTarget): Promise<OAuthQuotaSnapshot>;
    hasActiveRateLimitMark(accountKey: string): boolean;
}
export interface RunResetCreditInput {
    accountKey: string;
    expectedChatgptAccountId: string;
    retry: boolean;
}
export type ResetRedemptionErrorKind = 'invalid_account_key' | 'identity_mismatch' | 'cooldown_active' | 'expired_unreconciled' | 'retry_without_inflight' | 'not_exhausted' | 'no_eligible_credit';
export declare class ResetRedemptionError extends Error {
    readonly kind: ResetRedemptionErrorKind;
    readonly cooldownUntil?: number;
    constructor(kind: ResetRedemptionErrorKind, message: string, cooldownUntil?: number);
}
export interface ResetLocalAmbiguousOutcome {
    kind: 'ambiguous_local';
    raw: {
        reason: 'corrupt_in_flight';
    };
}
export type ResetRedemptionOutcome = ResetConsumeOutcome | ResetLocalAmbiguousOutcome;
export type ResetSelectedCredit = ResetCredit | {
    id: string;
};
export interface RunResetCreditResult {
    target: ResetResolvedTarget;
    selectedCredit: ResetSelectedCredit | undefined;
    beforeState: ResetAccountState | undefined;
    outcome: ResetRedemptionOutcome;
    retrySafety: string;
    finalizeStateWriteFailed?: boolean;
}
interface ResetClaim {
    inFlight: ResetInFlight;
    selectedCredit: ResetSelectedCredit;
}
type ResetStateDecision = {
    kind: 'fresh';
    beforeState: ResetAccountState | undefined;
} | {
    kind: 'claim';
    beforeState: ResetAccountState | undefined;
    claim: ResetClaim;
} | {
    kind: 'expired_unreconciled';
    beforeState: ResetAccountState | undefined;
    claim: ResetClaim;
} | {
    kind: 'cooldown';
    beforeState: ResetAccountState | undefined;
    cooldownUntil: number;
} | {
    kind: 'corrupt';
    beforeState: ResetAccountState | undefined;
};
export type ResetCreditErrorKind = 'http_error' | 'invalid_response';
export declare class ResetCreditError extends Error {
    readonly kind: ResetCreditErrorKind;
    readonly status?: number;
    constructor(kind: ResetCreditErrorKind, message: string, status?: number);
}
export declare function claimResetAttempt(deps: ResetStateDeps, accountKey: string, credits: readonly ResetCredit[]): Promise<ResetStateDecision>;
export declare function finalizeResetAttempt(deps: ResetStateDeps, accountKey: string, completing: ResetInFlight, outcome: ResetConsumeOutcome): Promise<void>;
export declare function resetWindowIsExhausted(window: {
    usedPercent: number;
    resetsAt?: string;
} | undefined, now: number): boolean;
export declare function evaluateResetPrecondition(quota: OAuthQuotaSnapshot, hasActiveRateLimitMark: boolean, now: number): ResetPrecondition;
export declare function listResetCredits(fetchImpl: typeof fetch, token: string, accountId?: string): Promise<ResetCreditList>;
export declare function selectCreditToSpend(credits: readonly ResetCredit[]): ResetCredit | undefined;
export declare function isResetCreditEligible(credit: ResetCredit): boolean;
export declare function countEligibleResetCredits(credits: readonly ResetCredit[]): number;
export declare function consumeResetCredit(fetchImpl: typeof fetch, token: string, accountId: string | undefined, creditId: string, redeemRequestId: string): Promise<ResetConsumeOutcome>;
export declare function runResetCreditRedemption(deps: RunResetCreditDeps, input: RunResetCreditInput): Promise<RunResetCreditResult>;
export {};
