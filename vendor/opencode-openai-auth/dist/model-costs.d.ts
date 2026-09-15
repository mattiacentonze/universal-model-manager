type CacheCost = {
    read: number;
    write: number;
};
type TierCost = {
    input: number;
    output: number;
    cache: CacheCost;
    tier: {
        type: 'context';
        size: number;
    };
};
export type ModelCost = {
    input: number;
    output: number;
    cache: CacheCost;
    tiers?: TierCost[];
    experimentalOver200K?: {
        input: number;
        output: number;
        cache: CacheCost;
    };
};
export declare function toSdkCost(raw: unknown): ModelCost | null;
export declare function loadModelsDevCosts(): Promise<Record<string, ModelCost> | null>;
/** Test-only: drop the memoized catalog so a later load re-reads its source. */
export declare function resetModelCostsForTest(): void;
export {};
