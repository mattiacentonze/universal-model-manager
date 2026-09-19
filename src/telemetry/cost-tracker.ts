import {
  type WindowedAccountState,
  type WindowedRecord,
  WindowedTracker,
  type WindowedTrackerOptions,
} from "./windowed-tracker.js";

export interface CostRecord extends WindowedRecord {
  timestamp: number;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
}

export interface AccountCostState extends WindowedAccountState<CostRecord> {
  records: CostRecord[];
  totalCostUsd: number;
  lastResetDay: number;
}

export interface ModelPricing {
  promptPer1M: number;
  completionPer1M: number;
}

export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  // Google models
  "gemini-2.5-pro": { promptPer1M: 1.25, completionPer1M: 5.0 },
  "gemini-2.5-flash": { promptPer1M: 0.075, completionPer1M: 0.3 },
  "gemini-3-flash": { promptPer1M: 0.1, completionPer1M: 0.4 },
  "gemini-3.8-flash": { promptPer1M: 0.1, completionPer1M: 0.4 },
  // OpenAI models
  "gpt-5": { promptPer1M: 2.5, completionPer1M: 10.0 },
  "gpt-5-mini": { promptPer1M: 0.15, completionPer1M: 0.6 },
  "gpt-6-astra": { promptPer1M: 2.0, completionPer1M: 8.0 },
};

export interface CostTrackerOptions extends WindowedTrackerOptions {
  windowMs?: number;
  clock?: () => number;
  pricing?: Record<string, ModelPricing>;
}

export class CostTracker extends WindowedTracker<CostRecord, AccountCostState, CostTrackerOptions> {
  private pricing: Record<string, ModelPricing>;

  constructor(options: CostTrackerOptions = {}) {
    super(options, 86_400_000); // 24 hours
    this.pricing = { ...DEFAULT_MODEL_PRICING, ...options.pricing };
  }

  protected createInitialState(_accountId: string, now: number): AccountCostState {
    return {
      records: [],
      totalCostUsd: 0,
      lastResetDay: Math.floor(now / 86_400_000),
    };
  }

  protected override onAfterPrune(state: AccountCostState, _now: number): void {
    state.totalCostUsd = state.records.reduce((sum, r) => sum + r.costUsd, 0);
  }

  public calculateCost(model: string, promptTokens: number, completionTokens: number): number {
    const key = Object.keys(this.pricing).find((k) => model.includes(k));
    const p = key ? this.pricing[key] : { promptPer1M: 0.5, completionPer1M: 2.0 };
    const promptCost = (promptTokens / 1_000_000) * p.promptPer1M;
    const completionCost = (completionTokens / 1_000_000) * p.completionPer1M;
    return promptCost + completionCost;
  }

  public recordUsage(
    accountId: string | number,
    model: string,
    promptTokens: number,
    completionTokens: number,
    directCostUsd?: number,
  ): number {
    const now = this.clock();
    const cost =
      directCostUsd !== undefined ? directCostUsd : this.calculateCost(model, promptTokens, completionTokens);

    this.addRecord(
      accountId,
      {
        timestamp: now,
        costUsd: cost,
        promptTokens,
        completionTokens,
      },
      now,
    );
    return cost;
  }

  public recordCost(
    accountId: string | number,
    costOrModel: number | string,
    promptTokens = 0,
    completionTokens = 0,
  ): number {
    let cost: number;
    let model = "";
    if (typeof costOrModel === "number") {
      cost = costOrModel;
      this.recordUsage(accountId, "", promptTokens, completionTokens, cost);
    } else {
      model = costOrModel;
      cost = this.recordUsage(accountId, model, promptTokens, completionTokens);
    }
    if (typeof accountId === "number" || /^\d+$/.test(String(accountId))) {
      const alias = `acct-${accountId}`;
      this.recordUsage(alias, model, promptTokens, completionTokens, cost);
    }
    if (model && String(accountId) !== model) {
      this.recordUsage(model, model, promptTokens, completionTokens, cost);
    }
    return cost;
  }

  public getAccumulatedCost(accountId: string | number): number {
    const state = this.getAccount(accountId);
    if (!state) return 0;
    this.prune(state, this.clock());
    return state.totalCostUsd;
  }

  public getCheapestAccounts(accountIds: Array<string | number>): string[] {
    return this.rankAccounts(accountIds, (a) => this.getAccumulatedCost(a));
  }
}
