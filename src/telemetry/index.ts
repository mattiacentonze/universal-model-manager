import { CostTracker } from "./cost-tracker.js";
import { LatencyTracker } from "./latency-tracker.js";

export * from "./cost-tracker.js";
export * from "./latency-tracker.js";

export class TelemetryStore {
  private static instance: TelemetryStore;

  public latency: LatencyTracker;
  public cost: CostTracker;

  constructor() {
    this.latency = new LatencyTracker();
    this.cost = new CostTracker();
  }

  public static getInstance(): TelemetryStore {
    if (!TelemetryStore.instance) {
      TelemetryStore.instance = new TelemetryStore();
    }
    return TelemetryStore.instance;
  }

  public static resetInstance(): void {
    TelemetryStore.instance = new TelemetryStore();
    (globalThis as any).__UMM_TELEMETRY__ = TelemetryStore.instance;
  }
}

export const telemetry = TelemetryStore.getInstance();
(globalThis as any).__UMM_TELEMETRY__ = telemetry;
