import { describe, expect, it } from "vitest";
import {
  defaultParametersForMode,
  mapLegacyRoutingMode,
  translateToProvider,
  type UnifiedRoutingConfig,
  validateConfig,
} from "../src/manager/index.js";
import { CostTracker } from "../src/telemetry/cost-tracker.js";
import { telemetry } from "../src/telemetry/index.js";
import { LatencyTracker } from "../src/telemetry/latency-tracker.js";

describe("Unified Routing Engine", () => {
  describe("Static field-name mapping (translateToProvider)", () => {
    it("maps main-first correctly for all providers", () => {
      const config: UnifiedRoutingConfig = {
        mode: "main-first",
        parameters: defaultParametersForMode("main-first"),
      };

      const google = translateToProvider(config, "google") as any;
      expect(google.account_selection_strategy).toBe("main-first");
      expect(google.scheduling_mode).toBe("cache_first");
      expect(google.switch_on_first_rate_limit).toBe(false);
      expect(google.proactive_rotation_threshold_percent).toBe(0);

      const openai = translateToProvider(config, "openai") as any;
      expect(openai.routing.mode).toBe("main-first");

      const zen = translateToProvider(config, "opencode-zen") as any;
      expect(zen.zenRoutingMode).toBe("main-first");
    });

    it("maps load-balancing correctly for all providers", () => {
      const config: UnifiedRoutingConfig = {
        mode: "load-balancing",
        parameters: defaultParametersForMode("load-balancing"),
      };

      const google = translateToProvider(config, "google") as any;
      expect(google.account_selection_strategy).toBe("round-robin");
      expect(google.scheduling_mode).toBe("performance_first");
      expect(google.switch_on_first_rate_limit).toBe(true);

      const openai = translateToProvider(config, "openai") as any;
      expect(openai.routing.mode).toBe("sticky-balanced");

      const zen = translateToProvider(config, "opencode-zen") as any;
      expect(zen.zenRoutingMode).toBe("sticky-balanced");
    });

    it("maps latency-based correctly for all providers", () => {
      const config: UnifiedRoutingConfig = {
        mode: "latency-based",
        parameters: defaultParametersForMode("latency-based"),
      };

      const google = translateToProvider(config, "google") as any;
      expect(google.account_selection_strategy).toBe("hybrid");
      expect(google.scheduling_mode).toBe("balance");
      expect(google.switch_on_first_rate_limit).toBe(true);

      const openai = translateToProvider(config, "openai") as any;
      expect(openai.routing.mode).toBe("sticky-balanced");
    });

    it("maps cost-based and usage-based with identical parameter types", () => {
      const config: UnifiedRoutingConfig = {
        mode: "usage-based",
        parameters: defaultParametersForMode("usage-based"),
      };
      expect(config.parameters.proactiveRotationThresholdPercent).toBe(20);

      const google = translateToProvider(config, "google") as any;
      expect(google.account_selection_strategy).toBe("hybrid");
      expect(google.proactive_rotation_threshold_percent).toBe(20);
    });
  });

  describe("Store migration & validation", () => {
    it("migrates legacy routingMode to router.routing", () => {
      const raw = {
        version: 1,
        accounts: [],
        router: {
          orchestrator: "iit/deepseek-v4-flash",
          enabled: true,
          routingMode: "sticky-balanced",
          tiers: {
            fast: { model: "iit/deepseek-v4-flash", fallback: [] },
            medium: { model: "openai/gpt-6-astra", fallback: [] },
            heavy: { model: "openai/gpt-6-astra", fallback: [] },
          },
        },
      };

      const parsed = validateConfig(raw);
      expect(parsed.router.routing).toBeDefined();
      expect(parsed.router.routing?.mode).toBe("load-balancing");
      expect(parsed.router.routing?.parameters.switchOnFirstRateLimit).toBe(true);
    });

    it("maps legacy mode strings to unified modes", () => {
      expect(mapLegacyRoutingMode("sticky")).toBe("main-first");
      expect(mapLegacyRoutingMode("main-first")).toBe("main-first");
      expect(mapLegacyRoutingMode("fallback-first")).toBe("main-first");
      expect(mapLegacyRoutingMode("balanced")).toBe("load-balancing");
      expect(mapLegacyRoutingMode("sticky-balanced")).toBe("load-balancing");
      expect(mapLegacyRoutingMode("round-robin")).toBe("load-balancing");
    });
  });

  describe("Unified Telemetry Module", () => {
    it("tracks moving average latency per account", () => {
      const tracker = new LatencyTracker({ alpha: 0.5 });
      tracker.recordLatency("acct-0", 200);
      expect(tracker.getAverageLatency("acct-0")).toBe(200);

      tracker.recordLatency("acct-0", 100);
      // EMA: 0.5 * 100 + 0.5 * 200 = 150
      expect(tracker.getAverageLatency("acct-0")).toBe(150);

      tracker.recordLatency("acct-1", 50);
      const ranked = tracker.getRankedAccounts(["acct-0", "acct-1"]);
      expect(ranked).toEqual(["acct-1", "acct-0"]);
    });

    it("tracks token usage and accumulated cost per account", () => {
      const tracker = new CostTracker();
      tracker.recordUsage("acct-0", "gemini-2.5-pro", 1_000_000, 1_000_000);
      // gemini-2.5-pro: 1.25 prompt + 5.0 completion = 6.25 USD
      expect(tracker.getAccumulatedCost("acct-0")).toBeCloseTo(6.25, 2);

      tracker.recordUsage("acct-1", "gemini-2.5-flash", 1_000_000, 1_000_000);
      // gemini-2.5-flash: 0.075 + 0.3 = 0.375 USD
      expect(tracker.getAccumulatedCost("acct-1")).toBeCloseTo(0.375, 2);

      const cheapest = tracker.getCheapestAccounts(["acct-0", "acct-1"]);
      expect(cheapest).toEqual(["acct-1", "acct-0"]);

      // Test recordCost directly with cost value
      tracker.recordCost("acct-2", 1.5, 1000, 500);
      expect(tracker.getAccumulatedCost("acct-2")).toBeCloseTo(1.5, 2);
    });

    it("provides unified singleton accessible globally", () => {
      expect(telemetry).toBeDefined();
      expect(telemetry.latency).toBeInstanceOf(LatencyTracker);
      expect(telemetry.cost).toBeInstanceOf(CostTracker);
      expect((globalThis as any).__UMM_TELEMETRY__).toBe(telemetry);
    });
  });
});
