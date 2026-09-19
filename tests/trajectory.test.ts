import { describe, expect, it } from "vitest";
import type { TrajectoryToolEvent } from "../src/model-router/telemetry/trajectory.js";
import {
  createTrajectory,
  createTrajectoryStore,
  dumpTrajectory,
  recordToolEvent,
  setStopReason,
  trajectoryMetrics,
} from "../src/model-router/telemetry/trajectory.js";

describe("model-router/telemetry/trajectory.ts", () => {
  describe("createTrajectory & recordToolEvent", () => {
    it("initializes trajectory state", () => {
      const state = createTrajectory("sess-1", "fast");
      expect(state.sessionID).toBe("sess-1");
      expect(state.tier).toBe("fast");
      expect(state.toolCallCount).toBe(0);
      expect(state.readCount).toBe(0);
      expect(state.execCount).toBe(0);
      expect(state.selfScriptCount).toBe(0);
      expect(state.redundantCount).toBe(0);
      expect(state.blockedCount).toBe(0);
      expect(state.deliverableExecuted).toBe(false);
      expect(state.ttfa).toBeNull();
      expect(state.stopReason).toBeNull();
      expect(state.dispatches).toBe(1);
    });

    it("records tool events accurately", () => {
      const state = createTrajectory("sess-1", "medium");

      // Read event
      const readEvt: TrajectoryToolEvent = {
        tool: "read",
        readOnly: true,
      };
      recordToolEvent(state, readEvt);
      expect(state.toolCallCount).toBe(1);
      expect(state.readCount).toBe(1);
      expect(state.execCount).toBe(0);
      expect(state.ttfa).toBeNull();

      // Mutation event (producing)
      const writeEvt: TrajectoryToolEvent = {
        tool: "write",
        readOnly: false,
        producing: true,
      };
      recordToolEvent(state, writeEvt);
      expect(state.toolCallCount).toBe(2);
      expect(state.readCount).toBe(1);
      expect(state.execCount).toBe(1);
      expect(state.ttfa).toBe(2);

      // Blocked & self script event
      const scriptEvt: TrajectoryToolEvent = {
        tool: "bash",
        readOnly: false,
        blocked: true,
        selfScript: true,
      };
      recordToolEvent(state, scriptEvt);
      expect(state.toolCallCount).toBe(3);
      expect(state.blockedCount).toBe(1);
      expect(state.selfScriptCount).toBe(1);

      // Redundant & deliverable event
      const delivEvt: TrajectoryToolEvent = {
        tool: "read",
        readOnly: true,
        redundant: true,
        deliverable: true,
      };
      recordToolEvent(state, delivEvt);
      expect(state.toolCallCount).toBe(4);
      expect(state.redundantCount).toBe(1);
      expect(state.deliverableExecuted).toBe(true);
    });
  });

  describe("setStopReason & trajectoryMetrics & dumpTrajectory", () => {
    it("sets stop reason once and ignores subsequent changes", () => {
      const state = createTrajectory("sess-1");
      setStopReason(state, "budget_exhausted");
      expect(state.stopReason).toBe("budget_exhausted");

      setStopReason(state, "other_reason");
      expect(state.stopReason).toBe("budget_exhausted");
    });

    it("computes trajectory metrics and ratio", () => {
      const state = createTrajectory("sess-1");
      state.readCount = 4;
      state.execCount = 2;
      state.toolCallCount = 6;
      state.stopReason = "completed";

      const metrics = trajectoryMetrics(state);
      expect(metrics.read_exec_ratio).toBe(2);
      expect(metrics.tool_call_count).toBe(6);
      expect(metrics.stop_reason).toBe("completed");

      // Zero execCount falls back to readCount
      state.execCount = 0;
      expect(trajectoryMetrics(state).read_exec_ratio).toBe(4);
    });

    it("dumps formatted JSON string", () => {
      const state = createTrajectory("sess-123");
      const dump = dumpTrajectory(state);
      expect(dump).toContain("[trajectory sess-123]");
      expect(dump).toContain('"tool_call_count":0');
    });
  });

  describe("createTrajectoryStore", () => {
    it("tracks state, resumes, notes, and sweeps idle sessions with clock", () => {
      let currentTime = 1000;
      const clock = () => currentTime;
      const store = createTrajectoryStore({ now: clock });

      const s1 = store.ensure("sess-1", "fast");
      expect(s1.sessionID).toBe("sess-1");
      expect(store.get("sess-1")).toBe(s1);

      store.recordToolEvent("sess-1", { tool: "read", readOnly: true });
      expect(s1.toolCallCount).toBe(1);

      store.recordResume("sess-1");
      expect(s1.dispatches).toBe(2);

      store.setStopReason("sess-1", "iteration_cap");
      expect(s1.stopReason).toBe("iteration_cap");

      const dumpStr = store.dump("sess-1");
      expect(dumpStr).toContain("[trajectory sess-1]");

      expect(store.dump("unknown")).toBeNull();

      // Test sweep eviction
      currentTime = 5000;
      store.ensure("sess-2", "medium"); // updated at 5000

      // sess-1 last touched at 1000, ttl = 3000 -> now=5000 - 1000 = 4000 >= 3000 -> evicted
      store.sweep(5000, 3000);
      expect(store.get("sess-1")).toBeUndefined();
      expect(store.get("sess-2")).toBeDefined();

      // Manual evict
      store.evict("sess-2");
      expect(store.get("sess-2")).toBeUndefined();
    });
  });
});
