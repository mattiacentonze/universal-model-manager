import { describe, it, expect } from "vitest";
import {
  tierRank,
  resolveStartTier,
  newLadderState,
  recordAttempt,
  nextTierAfter,
  buildLadderForcingMessage,
  nextAction,
  advance,
  buildEscalatePolicy,
  formatLadderScorecard,
} from "../src/model-router/escalate/ladder.js";
import type { EscalatePolicy } from "../src/model-router/escalate/ladder.js";
import type { RouterConfig } from "../src/model-router/router/config.js";

describe("model-router/escalate/ladder.ts", () => {
  const basePolicy: EscalatePolicy = {
    ladder: ["fast", "medium", "heavy"],
    floorTier: null,
    maxAttemptsPerTier: 2,
    maxTotalAttempts: 5,
    costMultiple: 3,
  };

  describe("tierRank and resolveStartTier", () => {
    it("returns correct index or -1", () => {
      expect(tierRank("fast", basePolicy.ladder)).toBe(0);
      expect(tierRank("medium", basePolicy.ladder)).toBe(1);
      expect(tierRank("heavy", basePolicy.ladder)).toBe(2);
      expect(tierRank("unknown", basePolicy.ladder)).toBe(-1);
    });

    it("resolves start tier respecting floorTier", () => {
      expect(resolveStartTier("fast", basePolicy)).toBe("fast");

      const withFloor: EscalatePolicy = {
        ...basePolicy,
        floorTier: "medium",
      };
      // When producerTier is lower than floorTier, floorTier wins
      expect(resolveStartTier("fast", withFloor)).toBe("medium");
      // When producerTier is higher than floorTier, producerTier wins
      expect(resolveStartTier("heavy", withFloor)).toBe("heavy");
    });
  });

  describe("newLadderState and recordAttempt", () => {
    it("initializes ladder state", () => {
      const state = newLadderState("fast", basePolicy);
      expect(state).toEqual({
        currentTier: "fast",
        attemptsThisTier: 0,
        totalAttempts: 0,
        escalations: 0,
        firstAttemptCost: null,
        cumulativeCost: 0,
      });
    });

    it("records attempts and tracks costs", () => {
      let state = newLadderState("fast", basePolicy);
      state = recordAttempt(state, 10);
      expect(state.totalAttempts).toBe(1);
      expect(state.firstAttemptCost).toBe(10);
      expect(state.cumulativeCost).toBe(10);

      state = recordAttempt(state, 15);
      expect(state.totalAttempts).toBe(2);
      expect(state.firstAttemptCost).toBe(10); // remains first attempt cost
      expect(state.cumulativeCost).toBe(25);
    });
  });

  describe("nextTierAfter and buildLadderForcingMessage", () => {
    it("finds next tier in ladder", () => {
      expect(nextTierAfter("fast", basePolicy)).toBe("medium");
      expect(nextTierAfter("medium", basePolicy)).toBe("heavy");
      expect(nextTierAfter("heavy", basePolicy)).toBeNull();
      expect(nextTierAfter("other", basePolicy)).toBeNull();
    });

    it("formats forcing message with reasons", () => {
      const msg = buildLadderForcingMessage(["check 1 failed", "check 2 timed out"]);
      expect(msg).toContain("- check 1 failed");
      expect(msg).toContain("- check 2 timed out");
      expect(msg).toContain("NEXT: retry with these failures addressed");

      const emptyMsg = buildLadderForcingMessage([]);
      expect(emptyMsg).toContain("- (no reasons provided)");
    });
  });

  describe("nextAction and advance", () => {
    it("returns 'accept' when verdict passes", () => {
      const state = newLadderState("fast", basePolicy);
      const action = nextAction(state, { pass: true }, basePolicy);
      expect(action).toEqual({ action: "accept" });
    });

    it("returns 'give_up' when maxTotalAttempts is reached", () => {
      const state = {
        ...newLadderState("fast", basePolicy),
        totalAttempts: 5,
      };
      const action = nextAction(state, { pass: false }, basePolicy);
      expect(action.action).toBe("give_up");
      expect(action.reason).toContain("max total attempts");
    });

    it("returns 'give_up' when cost ceiling is exceeded", () => {
      const state = {
        ...newLadderState("fast", basePolicy),
        firstAttemptCost: 10,
        cumulativeCost: 35, // > 10 * 3
      };
      const action = nextAction(state, { pass: false }, basePolicy);
      expect(action.action).toBe("give_up");
      expect(action.reason).toBe("cost ceiling exceeded");
    });

    it("returns 'retry' within the same tier when attemptsThisTier < maxAttemptsPerTier", () => {
      const state = {
        ...newLadderState("fast", basePolicy),
        attemptsThisTier: 0,
      };
      const action = nextAction(state, { pass: false, reasons: ["failed"] }, basePolicy);
      expect(action.action).toBe("retry");
      expect(action.tier).toBe("fast");
      expect(action.forcingMessage).toContain("failed");

      const advanced = advance(state, action);
      expect(advanced.attemptsThisTier).toBe(1);
      expect(advanced.currentTier).toBe("fast");
    });

    it("returns 'escalate' when attemptsThisTier reaches maxAttemptsPerTier", () => {
      const state = {
        ...newLadderState("fast", basePolicy),
        attemptsThisTier: 2,
      };
      const action = nextAction(state, { pass: false, reasons: ["still failed"] }, basePolicy);
      expect(action.action).toBe("escalate");
      expect(action.tier).toBe("medium");

      const advanced = advance(state, action);
      expect(advanced.currentTier).toBe("medium");
      expect(advanced.attemptsThisTier).toBe(0);
      expect(advanced.escalations).toBe(1);
    });

    it("returns 'give_up' when at the top of the ladder and attempts exhausted", () => {
      const state = {
        ...newLadderState("heavy", basePolicy),
        attemptsThisTier: 2,
      };
      const action = nextAction(state, { pass: false }, basePolicy);
      expect(action.action).toBe("give_up");
      expect(action.reason).toContain("already at top of ladder");
    });
  });

  describe("buildEscalatePolicy & formatLadderScorecard", () => {
    it("builds policy with fallback defaults", () => {
      const cfg: RouterConfig = {
        activePreset: "default",
        presets: {},
        rules: [],
        defaultTier: "fast",
      };
      const policy = buildEscalatePolicy(cfg);
      expect(policy.ladder).toEqual(["fast", "medium", "heavy"]);
      expect(policy.maxAttemptsPerTier).toBe(1);
      expect(policy.maxTotalAttempts).toBe(4);
      expect(policy.costMultiple).toBe(4);
    });

    it("builds policy from router config", () => {
      const cfg: RouterConfig = {
        activePreset: "default",
        presets: {},
        rules: [],
        defaultTier: "fast",
        enforcement: {
          escalate: {
            ladder: ["fast", "heavy"],
            floorTier: "fast",
            maxAttemptsPerTier: 3,
            maxTotalAttempts: 6,
            costCeiling: { multiple: 5 },
          },
        },
      };
      const policy = buildEscalatePolicy(cfg);
      expect(policy.ladder).toEqual(["fast", "heavy"]);
      expect(policy.floorTier).toBe("fast");
      expect(policy.maxAttemptsPerTier).toBe(3);
      expect(policy.maxTotalAttempts).toBe(6);
      expect(policy.costMultiple).toBe(5);
    });

    it("formats scorecard correctly", () => {
      const state = {
        currentTier: "heavy",
        attemptsThisTier: 1,
        totalAttempts: 3,
        escalations: 2,
        firstAttemptCost: 10,
        cumulativeCost: 25,
      };
      const card = formatLadderScorecard(state, true, "deterministic");
      expect(card).toBe(
        "[router delegate scorecard | final_tier=heavy | attempts=3 | escalations=2 | cost=25 | verdict=PASS | method=deterministic]"
      );
    });
  });
});
