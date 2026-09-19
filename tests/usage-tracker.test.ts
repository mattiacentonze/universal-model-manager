import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageTracker } from "../src/chatgpt-web/usage-tracker.js";

describe("UsageTracker", () => {
  it("records turns and reports window statistics", () => {
    const testFile = join(tmpdir(), `test-usage-${Date.now()}.json`);
    const mockSessionStore: any = { hasValidSession: () => true };
    const tracker = new UsageTracker(testFile, mockSessionStore);

    expect(tracker.getStatus().turnsInWindow).toBe(0);
    expect(tracker.getStatus().isLoggedIn).toBe(true);

    tracker.recordTurn();
    tracker.recordTurn();
    expect(tracker.getStatus().turnsInWindow).toBe(2);

    tracker.recordRateLimit(Date.now() + 60_000, "Too many requests");
    expect(tracker.getStatus().isRateLimited).toBe(true);
    expect(tracker.getStatus().rateLimitResetFormatted).not.toBeNull();

    tracker.clearRateLimit();
    expect(tracker.getStatus().isRateLimited).toBe(false);

    rmSync(testFile, { force: true });
  });
});
