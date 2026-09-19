import { describe, expect, it } from "vitest";
import type { GuardStoreLike } from "../src/model-router/guard/enforce.js";
import {
  buildGuardPolicy,
  CUMULATIVE_BUDGET_MULTIPLIER,
  CUMULATIVE_GUARD_BUDGET,
  DEFAULT_GUARD_BUDGET,
  formatScorecard,
  guardAfterCall,
  guardBeforeCall,
} from "../src/model-router/guard/enforce.js";
import type { GuardCall, GuardPolicy, GuardState } from "../src/model-router/guard/guards.js";
import {
  classify,
  evaluateGuards,
  forcingMessage,
  isSelfScript,
  newGuardState,
  observationOk,
  recordBlock,
  trajectoryMetrics,
  updateState,
} from "../src/model-router/guard/guards.js";
import type { RouterConfig } from "../src/model-router/router/config.js";

describe("model-router/guard/guards.ts", () => {
  const basePolicy: GuardPolicy = {
    budget: 10,
    cumulativeBudget: 30,
    readDraftCap: 3,
    sameOpRetryCap: 1,
    blockSelfScript: true,
    deliverableFirst: true,
    deliverableSignal: null,
    deliverablePath: null,
    deliverableIsScript: false,
    blockScriptWrites: false,
  };

  describe("newGuardState", () => {
    it("initializes state correctly from policy", () => {
      const state = newGuardState(basePolicy);
      expect(state.budget).toBe(10);
      expect(state.toolCallCount).toBe(0);
      expect(state.totalToolCallCount).toBe(0);
      expect(state.dispatches).toBe(1);
      expect(state.readCount).toBe(0);
      expect(state.execCount).toBe(0);
      expect(state.selfScriptCount).toBe(0);
      expect(state.redundantCount).toBe(0);
      expect(state.blockedCount).toBe(0);
      expect(state.consecutiveNonProducing).toBe(0);
      expect(state.deliverableExecuted).toBe(false);
      expect(state.ttfa).toBeNull();
      expect(state.lastBlock).toBeNull();
      expect(state.seen.size).toBe(0);
    });
  });

  describe("isSelfScript", () => {
    it("identifies heredocs and bash redirects as self-scripting", () => {
      const callHeredoc: GuardCall = {
        tool: "bash",
        args: { command: "cat <<EOF > test.py\nprint(1)\nEOF" },
      };
      expect(isSelfScript(callHeredoc, basePolicy)).toBe(true);

      const callRedirect: GuardCall = {
        tool: "bash",
        args: { command: "echo 'hello' > script.sh" },
      };
      expect(isSelfScript(callRedirect, basePolicy)).toBe(true);

      const callInline: GuardCall = {
        tool: "shell",
        args: { cmd: "node -e 'console.log(1)'" },
      };
      expect(isSelfScript(callInline, basePolicy)).toBe(true);

      const callBashC: GuardCall = {
        tool: "bash",
        args: { command: "bash -c 'ls -la'" },
      };
      expect(isSelfScript(callBashC, basePolicy)).toBe(true);

      const callCatWrite: GuardCall = {
        tool: "bash",
        args: { command: "cat > out.txt" },
      };
      expect(isSelfScript(callCatWrite, basePolicy)).toBe(true);
    });

    it("treats over-length commands as suspicious self-script", () => {
      const longCommand = "a".repeat(20005);
      const callLong: GuardCall = {
        tool: "bash",
        args: { command: longCommand },
      };
      expect(isSelfScript(callLong, basePolicy)).toBe(true);
    });

    it("allows harmless bash commands", () => {
      const callNormal: GuardCall = {
        tool: "bash",
        args: { command: "npm test" },
      };
      expect(isSelfScript(callNormal, basePolicy)).toBe(false);

      const callEmpty: GuardCall = {
        tool: "bash",
        args: { command: "" },
      };
      expect(isSelfScript(callEmpty, basePolicy)).toBe(false);
    });

    it("exempts self-scripting when deliverableIsScript is true", () => {
      const policy: GuardPolicy = { ...basePolicy, deliverableIsScript: true };
      const call: GuardCall = {
        tool: "bash",
        args: { command: "cat <<EOF > run.sh\necho 1\nEOF" },
      };
      expect(isSelfScript(call, policy)).toBe(false);
    });

    it("exempts self-scripting when target matches deliverablePath", () => {
      const policy: GuardPolicy = { ...basePolicy, deliverablePath: "src/cli.ts", blockScriptWrites: true };
      const call: GuardCall = {
        tool: "write",
        args: { filePath: "src/cli.ts" },
      };
      expect(isSelfScript(call, policy)).toBe(false);

      const callOther: GuardCall = {
        tool: "write",
        args: { filePath: "src/other.ts" },
      };
      expect(isSelfScript(callOther, policy)).toBe(true);
    });

    it("handles blockScriptWrites toggle for write tools", () => {
      const writeCall: GuardCall = {
        tool: "write",
        args: { filePath: "temp.js" },
      };
      expect(isSelfScript(writeCall, { ...basePolicy, blockScriptWrites: false })).toBe(false);
      expect(isSelfScript(writeCall, { ...basePolicy, blockScriptWrites: true })).toBe(true);

      const nonScriptWrite: GuardCall = {
        tool: "edit",
        args: { path: "data.json" },
      };
      expect(isSelfScript(nonScriptWrite, { ...basePolicy, blockScriptWrites: true })).toBe(false);
    });
  });

  describe("classify", () => {
    it("classifies finish tools", () => {
      expect(classify({ tool: "finish" }, basePolicy)).toBe("finish");
      expect(classify({ tool: "return" }, basePolicy)).toBe("finish");
      expect(classify({ tool: "task_complete" }, basePolicy)).toBe("finish");
    });

    it("classifies self_script before mutation or read", () => {
      const call: GuardCall = {
        tool: "bash",
        args: { command: "python -c 'print(1)'" },
      };
      expect(classify(call, basePolicy)).toBe("self_script");
    });

    it("classifies read-only tools", () => {
      expect(classify({ tool: "read" }, basePolicy)).toBe("read");
      expect(classify({ tool: "glob" }, basePolicy)).toBe("read");
      expect(classify({ tool: "grep" }, basePolicy)).toBe("read");
    });

    it("classifies mutation tools", () => {
      expect(classify({ tool: "write" }, basePolicy)).toBe("mutation");
      expect(classify({ tool: "edit" }, basePolicy)).toBe("mutation");
      expect(classify({ tool: "patch" }, basePolicy)).toBe("mutation");
      expect(classify({ tool: "bash", args: { command: "npm test" } }, basePolicy)).toBe("mutation");
    });

    it("classifies unknown tools as other", () => {
      expect(classify({ tool: "custom_mcp_tool" }, basePolicy)).toBe("other");
    });
  });

  describe("evaluateGuards", () => {
    it("allows finish tools regardless of budget", () => {
      const state = newGuardState(basePolicy);
      state.toolCallCount = 100;
      const decision = evaluateGuards(state, { tool: "finish" }, basePolicy);
      expect(decision.allow).toBe(true);
      expect(decision.guard).toBeNull();
    });

    it("blocks self_script when blockSelfScript is true", () => {
      const state = newGuardState(basePolicy);
      const call: GuardCall = { tool: "bash", args: { command: "node -e 'x=1'" } };
      const decision = evaluateGuards(state, call, basePolicy);
      expect(decision.allow).toBe(false);
      expect(decision.guard).toBe("anti_self_script");
    });

    it("allows self_script as mutation when blockSelfScript is false", () => {
      const state = newGuardState(basePolicy);
      const call: GuardCall = { tool: "bash", args: { command: "node -e 'x=1'" } };
      const decision = evaluateGuards(state, call, { ...basePolicy, blockSelfScript: false });
      expect(decision.allow).toBe(true);
      expect(decision.guard).toBeNull();
    });

    it("enforces tool call iteration budget", () => {
      const state = newGuardState(basePolicy);
      state.toolCallCount = 10;
      const call: GuardCall = { tool: "read", args: { filePath: "foo.txt" } };
      const decision = evaluateGuards(state, call, basePolicy);
      expect(decision.allow).toBe(false);
      expect(decision.guard).toBe("iteration_cap");
    });

    it("enforces cumulative tool call budget across dispatches", () => {
      const state = newGuardState({ ...basePolicy, budget: 10, cumulativeBudget: 15 });
      state.toolCallCount = 5;
      state.totalToolCallCount = 15;
      const call: GuardCall = { tool: "read", args: { filePath: "foo.txt" } };
      const decision = evaluateGuards(state, call, { ...basePolicy, budget: 10, cumulativeBudget: 15 });
      expect(decision.allow).toBe(false);
      expect(decision.guard).toBe("cumulative_iteration_cap");
    });

    it("detects redundant reads past sameOpRetryCap", () => {
      const state = newGuardState(basePolicy);
      const call: GuardCall = { tool: "read", args: { filePath: "foo.txt" } };
      // Simulate that foo.txt was already read once
      updateState(state, call, { ok: true }, basePolicy);
      expect(state.seen.size).toBe(1);

      // Now evaluate the same read again with sameOpRetryCap = 1
      const decision = evaluateGuards(state, call, basePolicy);
      expect(decision.allow).toBe(false);
      expect(decision.guard).toBe("redundant_read");
    });

    it("enforces read budget (consecutive non-producing actions)", () => {
      const state = newGuardState(basePolicy);
      state.consecutiveNonProducing = 3;
      const call: GuardCall = { tool: "read", args: { filePath: "bar.txt" } };
      const decision = evaluateGuards(state, call, basePolicy);
      expect(decision.allow).toBe(false);
      expect(decision.guard).toBe("read_budget");
    });

    it("enforces deliverable_first when deliverableSignal is specified and unexecuted", () => {
      const policy: GuardPolicy = {
        ...basePolicy,
        deliverableFirst: true,
        deliverableSignal: "npm run build",
      };
      const state = newGuardState(policy);
      state.deliverableExecuted = false;

      const readCall: GuardCall = { tool: "read", args: { filePath: "bar.txt" } };
      const decision = evaluateGuards(state, readCall, policy);
      expect(decision.allow).toBe(false);
      expect(decision.guard).toBe("deliverable_first");
    });
  });

  describe("updateState and recordBlock", () => {
    it("tracks mutations and resets consecutiveNonProducing", () => {
      const state = newGuardState(basePolicy);
      state.consecutiveNonProducing = 2;

      const call: GuardCall = { tool: "write", args: { filePath: "a.ts" } };
      updateState(state, call, { ok: true }, basePolicy);

      expect(state.toolCallCount).toBe(1);
      expect(state.totalToolCallCount).toBe(1);
      expect(state.execCount).toBe(1);
      expect(state.consecutiveNonProducing).toBe(0);
      expect(state.deliverableExecuted).toBe(true);
      expect(state.ttfa).toBe(1);
    });

    it("tracks failed mutations without marking deliverableExecuted", () => {
      const state = newGuardState(basePolicy);
      const call: GuardCall = { tool: "bash", args: { command: "npm test" } };
      updateState(state, call, { ok: false }, basePolicy);

      expect(state.execCount).toBe(1);
      expect(state.deliverableExecuted).toBe(false);
      expect(state.ttfa).toBeNull();
    });

    it("records blocks and updates redundant count", () => {
      const state = newGuardState(basePolicy);
      recordBlock(state, { allow: false, guard: "redundant_read", observation: "denied" });

      expect(state.blockedCount).toBe(1);
      expect(state.redundantCount).toBe(1);
      expect(state.lastBlock).toBe("redundant_read");
    });
  });

  describe("forcingMessage and trajectoryMetrics", () => {
    it("generates appropriate forcing message", () => {
      const state = newGuardState(basePolicy);
      state.toolCallCount = 2;
      state.consecutiveNonProducing = 2;

      const msg = forcingMessage(state, basePolicy);
      expect(msg).toContain("[budget 2/10 | deliverable=n/a | reads_since_produce=2]");
      expect(msg).toContain("NEXT: take a producing action");

      const deliverablePolicy: GuardPolicy = {
        ...basePolicy,
        deliverableSignal: "test:run",
      };
      const msgDeliv = forcingMessage(state, deliverablePolicy);
      expect(msgDeliv).toContain("NEXT: run the deliverable (test:run)");
    });

    it("calculates trajectory metrics", () => {
      const state = newGuardState(basePolicy);
      state.readCount = 4;
      state.execCount = 2;
      state.selfScriptCount = 1;
      state.toolCallCount = 7;
      state.totalToolCallCount = 7;
      state.dispatches = 1;
      state.blockedCount = 1;
      state.redundantCount = 1;
      state.consecutiveNonProducing = 0;
      state.deliverableExecuted = true;
      state.ttfa = 3;

      const metrics = trajectoryMetrics(state);
      expect(metrics).toEqual({
        ttfa: 3,
        read_exec_ratio: 2,
        self_script_count: 1,
        tool_call_count: 7,
        total_tool_call_count: 7,
        dispatches: 1,
        deliverable_executed: true,
        blocked_count: 1,
        redundant_count: 1,
        consecutive_non_producing: 0,
      });

      state.execCount = 0;
      expect(trajectoryMetrics(state).read_exec_ratio).toBe(4);
    });
  });

  describe("observationOk", () => {
    it("returns true for empty or success messages", () => {
      expect(observationOk(undefined)).toBe(true);
      expect(observationOk("")).toBe(true);
      expect(observationOk("Success: 12 tests passed")).toBe(true);
      expect(observationOk("  done in 2s")).toBe(true);
    });

    it("returns false for error prefixes", () => {
      expect(observationOk("DENIED: budget exceeded")).toBe(false);
      expect(observationOk("BLOCKED: self script")).toBe(false);
      expect(observationOk("Error: not found")).toBe(false);
      expect(observationOk("error: command failed")).toBe(false);
      expect(observationOk("ERROR in build")).toBe(false);
      expect(observationOk("Exception in thread")).toBe(false);
      expect(observationOk("Traceback (most recent call last):")).toBe(false);
      expect(observationOk("FAIL: 1 test failed")).toBe(false);
      expect(observationOk("failed: exit 1")).toBe(false);
    });
  });
});

describe("model-router/guard/enforce.ts", () => {
  function createFakeStore(): GuardStoreLike & { states: Map<string, GuardState>; notes: Map<string, string> } {
    const states = new Map<string, GuardState>();
    const notes = new Map<string, string>();
    return {
      states,
      notes,
      ensure(sessionID: string, policy: GuardPolicy) {
        let s = states.get(sessionID);
        if (!s) {
          s = newGuardState(policy);
          states.set(sessionID, s);
        }
        return s;
      },
      get(sessionID: string) {
        return states.get(sessionID);
      },
      setPendingNote(sessionID: string, note: string) {
        notes.set(sessionID, note);
      },
      takePendingNote(sessionID: string) {
        const n = notes.get(sessionID);
        notes.delete(sessionID);
        return n;
      },
    };
  }

  const baseConfig: RouterConfig = {
    activePreset: "default",
    presets: {},
    rules: [],
    defaultTier: "fast",
  };

  it("buildGuardPolicy sets defaults and scales cumulativeBudget", () => {
    const policy = buildGuardPolicy(baseConfig, "heavy");
    expect(policy.budget).toBe(DEFAULT_GUARD_BUDGET);
    expect(policy.cumulativeBudget).toBe(CUMULATIVE_GUARD_BUDGET);
    expect(policy.readDraftCap).toBe(3);
    expect(policy.sameOpRetryCap).toBe(1);
    expect(policy.blockSelfScript).toBe(true);

    const customCfg: RouterConfig = {
      activePreset: "default",
      presets: {},
      rules: [],
      defaultTier: "fast",
      enforcement: {
        guard: {
          budget: 15,
          readDraftCap: 5,
          sameOpRetryCap: 2,
          blockSelfScript: false,
          blockScriptWrites: true,
          deliverableFirst: false,
        },
      },
    };
    const customPolicy = buildGuardPolicy(customCfg, "fast");
    expect(customPolicy.budget).toBe(15);
    expect(customPolicy.cumulativeBudget).toBe(15 * CUMULATIVE_BUDGET_MULTIPLIER);
    expect(customPolicy.readDraftCap).toBe(5);
    expect(customPolicy.sameOpRetryCap).toBe(2);
    expect(customPolicy.blockSelfScript).toBe(false);
    expect(customPolicy.blockScriptWrites).toBe(true);
    expect(customPolicy.deliverableFirst).toBe(false);
  });

  it("formatScorecard creates formatted string", () => {
    const policy = buildGuardPolicy(baseConfig, "heavy");
    const state = newGuardState(policy);
    state.readCount = 3;
    state.execCount = 1;
    state.toolCallCount = 4;
    state.lastBlock = "read_budget";
    state.ttfa = 2;

    const card = formatScorecard(state, "heavy");
    expect(card).toBe(
      "[router scorecard | tier=heavy | ttfa=2 | read:exec=3:1 | self_scripts=0 | tool_calls=4 | blocks=0 | stop=read_budget]",
    );
  });

  describe("guardBeforeCall & guardAfterCall", () => {
    it("does nothing when enforcement mode is off", () => {
      const store = createFakeStore();
      const cfg: RouterConfig = {
        activePreset: "default",
        presets: {},
        rules: [],
        defaultTier: "fast",
        enforcement: { mode: "off" },
      };

      const before = guardBeforeCall({
        cfg,
        tier: "fast",
        sessionID: "s1",
        tool: "bash",
        toolArgs: { command: "cat <<EOF > test.sh" },
        store,
        env: {},
      });

      expect(before.block).toBe(false);
      expect(before.mode).toBe("off");
      expect(store.states.size).toBe(0);

      const out = { output: "result" };
      guardAfterCall({
        cfg,
        tier: "fast",
        sessionID: "s1",
        tool: "bash",
        toolArgs: { command: "cat <<EOF > test.sh" },
        output: out,
        store,
      });
      expect(out.output).toBe("result");
    });

    it("advisory mode notes violation without blocking", () => {
      const store = createFakeStore();
      const cfg: RouterConfig = {
        activePreset: "default",
        presets: {},
        rules: [],
        defaultTier: "fast",
        enforcement: { mode: "advisory" },
      };

      const before = guardBeforeCall({
        cfg,
        tier: "fast",
        sessionID: "s2",
        tool: "bash",
        toolArgs: { command: "node -e 'process.exit(0)'" },
        store,
        env: {},
      });

      expect(before.block).toBe(false);
      expect(before.mode).toBe("advisory");
      expect(before.guard).toBe("anti_self_script");
      expect(store.notes.has("s2")).toBe(true);

      const out = { output: "original output" };
      guardAfterCall({
        cfg,
        tier: "fast",
        sessionID: "s2",
        tool: "bash",
        toolArgs: { command: "node -e 'process.exit(0)'" },
        output: out,
        store,
      });

      expect(typeof out.output).toBe("string");
      expect(out.output).toContain("original output");
      expect(out.output).toContain("[⚠ GUARD:anti_self_script]");
    });

    it("enforced mode blocks forbidden tool calls and counts the attempt", () => {
      const store = createFakeStore();
      const cfg: RouterConfig = {
        activePreset: "default",
        presets: {},
        rules: [],
        defaultTier: "fast",
        enforcement: { mode: "enforced" },
      };

      const before = guardBeforeCall({
        cfg,
        tier: "fast",
        sessionID: "s3",
        tool: "bash",
        toolArgs: { command: "cat <<EOF > temp.py" },
        store,
        env: {},
      });

      expect(before.block).toBe(true);
      expect(before.mode).toBe("enforced");
      expect(before.guard).toBe("anti_self_script");
      expect(before.message).toContain("DENIED: do not author or run a throwaway script");

      const state = store.get("s3")!;
      expect(state.selfScriptCount).toBe(1);
      expect(state.blockedCount).toBe(1);
      expect(state.lastBlock).toBe("anti_self_script");
    });

    it("downgrades trivial calls from enforced to advisory if trivialBypass is true", () => {
      const store = createFakeStore();
      const cfg: RouterConfig = {
        activePreset: "default",
        presets: {},
        rules: [],
        defaultTier: "fast",
        enforcement: {
          mode: "enforced",
          proportional: { trivialBypass: true },
        },
      };

      const before = guardBeforeCall({
        cfg,
        tier: "fast",
        sessionID: "s4",
        tool: "bash",
        toolArgs: { command: "cat <<EOF > temp.py" },
        store,
        env: {},
        trivial: true,
      });

      expect(before.block).toBe(false);
      expect(before.mode).toBe("advisory");
      expect(before.guard).toBe("anti_self_script");
    });
  });
});
