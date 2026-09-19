import { describe, expect, it } from "vitest";
import { CostTracker } from "../src/telemetry/cost-tracker.js";
import { LatencyTracker } from "../src/telemetry/latency-tracker.js";
import { type WindowedAccountState, type WindowedRecord, WindowedTracker } from "../src/telemetry/windowed-tracker.js";

interface TestRecord extends WindowedRecord {
  timestamp: number;
  val: number;
}

interface TestState extends WindowedAccountState<TestRecord> {
  records: TestRecord[];
  sum: number;
}

class TestTracker extends WindowedTracker<TestRecord, TestState> {
  protected createInitialState(): TestState {
    return { records: [], sum: 0 };
  }

  protected override onAfterPrune(state: TestState): void {
    state.sum = state.records.reduce((acc, r) => acc + r.val, 0);
  }

  public record(accountId: string, val: number): void {
    const now = this.clock();
    this.addRecord(accountId, { timestamp: now, val }, now);
  }

  public getSum(accountId: string): number {
    const state = this.getAccount(accountId);
    if (!state) return 0;
    this.prune(state, this.clock());
    return state.sum;
  }
}

describe("WindowedTracker Core Generic", () => {
  it("manages sliding window expiration and state pruning", () => {
    let mockTime = 1000;
    const tracker = new TestTracker({ windowMs: 500, clock: () => mockTime });

    tracker.record("user-1", 10);
    mockTime = 1200;
    tracker.record("user-1", 20);

    expect(tracker.getSum("user-1")).toBe(30);

    // Advance beyond window for first record (1000 + 500 = 1500)
    mockTime = 1600;
    expect(tracker.getSum("user-1")).toBe(20);

    // Advance beyond window for second record
    mockTime = 1800;
    expect(tracker.getSum("user-1")).toBe(0);
  });

  it("ranks accounts using rankAccounts scoreFn", () => {
    const tracker = new TestTracker();
    tracker.record("user-a", 100);
    tracker.record("user-b", 50);
    tracker.record("user-c", 75);

    const ranked = tracker.rankAccounts(["user-a", "user-b", "user-c"], (id) => tracker.getSum(id));
    expect(ranked).toEqual(["user-b", "user-c", "user-a"]);
  });

  it("clears all accounts on clear()", () => {
    const tracker = new TestTracker();
    tracker.record("user-1", 10);
    expect(tracker.getSum("user-1")).toBe(10);

    tracker.clear();
    expect(tracker.getSum("user-1")).toBe(0);
    expect(tracker.getAccount("user-1")).toBeUndefined();
  });

  it("CostTracker and LatencyTracker properly extend WindowedTracker", () => {
    const costTracker = new CostTracker();
    const latencyTracker = new LatencyTracker();

    expect(costTracker).toBeInstanceOf(WindowedTracker);
    expect(latencyTracker).toBeInstanceOf(WindowedTracker);
  });
});
