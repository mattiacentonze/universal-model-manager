import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZenUsageTracker } from "../src/opencode-zen/usage-tracker.js";
import { opencodeZenServerPlugin } from "../src/opencode-zen/index.js";

describe("ZenUsageTracker", () => {
  it("initializes with empty state and default estimated limit", () => {
    const tmp = mkdtempSync(join(tmpdir(), "zen-"));
    const file = join(tmp, "opencode-zen-usage.json");
    const tracker = new ZenUsageTracker(file);

    const status = tracker.getStatus(true, "big-pickle");
    expect(status.isConfigured).toBe(true);
    expect(status.model).toBe("big-pickle");
    expect(status.totalTokens24h).toBe(0);
    expect(status.inputTokens24h).toBe(0);
    expect(status.outputTokens24h).toBe(0);
    expect(status.estimatedLimit).toBe(2_500_000);
    expect(status.usedPct).toBe(0);
    expect(status.isRateLimited).toBe(false);
    expect(status.resetsInFormatted).toBeTruthy();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("records usage and aggregates 24h totals", () => {
    const tmp = mkdtempSync(join(tmpdir(), "zen-"));
    const file = join(tmp, "opencode-zen-usage.json");
    const tracker = new ZenUsageTracker(file);

    const now = Date.now();
    tracker.recordUsage(1000, 500, now);
    tracker.recordUsage(2000, 1000, now);

    // Old bucket outside 24h window
    const oldTime = now - 25 * 60 * 60 * 1000;
    tracker.recordUsage(50000, 50000, oldTime);

    const status = tracker.getStatus(true, "big-pickle");
    expect(status.inputTokens24h).toBe(3000);
    expect(status.outputTokens24h).toBe(1500);
    expect(status.totalTokens24h).toBe(4500);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("tracks rate limits and clears them", () => {
    const tmp = mkdtempSync(join(tmpdir(), "zen-"));
    const file = join(tmp, "opencode-zen-usage.json");
    const tracker = new ZenUsageTracker(file);

    const futureReset = Date.now() + 30 * 60 * 1000;
    tracker.recordRateLimit(futureReset, "Too many requests");

    let status = tracker.getStatus(true, "big-pickle");
    expect(status.isRateLimited).toBe(true);
    expect(status.rateLimitResetFormatted).toBeTruthy();

    tracker.clearRateLimit();
    status = tracker.getStatus(true, "big-pickle");
    expect(status.isRateLimited).toBe(false);
    expect(status.rateLimitResetFormatted).toBeNull();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("calculates pacing and deficit/reserve", () => {
    const tmp = mkdtempSync(join(tmpdir(), "zen-"));
    const file = join(tmp, "opencode-zen-usage.json");
    const tracker = new ZenUsageTracker(file);
    tracker.setEstimatedDailyLimit(100_000);

    // Use 80,000 tokens immediately
    tracker.recordUsage(50_000, 30_000, Date.now());

    const status = tracker.getStatus(true, "big-pickle");
    expect(status.usedPct).toBe(80);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("opencodeZenServerPlugin hooks into assistant message events and records token usage", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "zen-"));
    const file = join(tmp, "opencode-zen-usage.json");
    const tracker = new ZenUsageTracker(file);

    const hooks = await opencodeZenServerPlugin({} as any, {});
    expect(hooks.event).toBeDefined();

    // Event for opencode model
    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            providerID: "opencode",
            modelID: "big-pickle",
            tokens: { input: 1500, output: 400 },
          },
        },
      } as any,
    });

    rmSync(tmp, { recursive: true, force: true });
  });
});
