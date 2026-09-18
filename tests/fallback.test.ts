import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dedupeChain, managerFallbackChain, fallbackPlugin } from "../src/fallback/index.js";
import fallbackEngine from "../src/fallback/engine.js";
import { emptyConfig, saveConfig } from "../src/manager/store.js";

function fakeDataDir(): string {
  return mkdtempSync(join(tmpdir(), "ufbdata-"));
}

function fakeConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "ufbconf-"));
}

/** Point the manager at an isolated data dir for the duration of a test. */
function isolateEnv(dataDir: string, configDir: string): void {
  vi.stubEnv("OPENCODE_UNIVERSAL_AUTH_DIR", dataDir);
  vi.stubEnv("OPENCODE_CONFIG_DIR", configDir);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("managerFallbackChain", () => {
  it("includes tier primary models plus fallback targets, deduped", () => {
    const dataDir = fakeDataDir();
    const cfg = emptyConfig();
    saveConfig(cfg, dataDir);
    isolateEnv(dataDir, fakeConfigDir());
    const chain = managerFallbackChain();
    // Tier primaries are present (not just fallback targets).
    expect(chain).toContain(cfg.router.tiers.medium.model); // openai/gpt-6-astra
    expect(chain).toContain(cfg.router.tiers.fast.model); // iit/deepseek-v4-flash
    // Fallback targets are present.
    expect(chain).toContain("google/antigravity-gemini-3.8-flash");
    // No duplicates.
    expect(new Set(chain).size).toBe(chain.length);
  });

  it("preserves explicit ordering and does not drop same-provider models", () => {
    const dataDir = fakeDataDir();
    const cfg = emptyConfig();
    // A Google-heavy chain must be preserved as configured (only exact dups removed).
    cfg.router.tiers.medium.model = "google/antigravity-gemini-3.8-flash";
    cfg.router.tiers.medium.fallback = ["google/antigravity-gemini-3.8-flash-2", "iit/deepseek-v4-flash"];
    cfg.router.tiers.medium.fallbackVariants = {};
    cfg.router.tiers.medium.targets = [
      { model: "google/antigravity-gemini-3.8-flash-2" },
      { model: "iit/deepseek-v4-flash" },
    ];
    saveConfig(cfg, dataDir);
    isolateEnv(dataDir, fakeConfigDir());
    const chain = managerFallbackChain();
    // Consecutive same-provider models are preserved (not dropped).
    expect(chain).toContain("google/antigravity-gemini-3.8-flash-2");
    expect(chain.indexOf("google/antigravity-gemini-3.8-flash")).toBeLessThan(
      chain.indexOf("google/antigravity-gemini-3.8-flash-2"),
    );
  });
});

describe("dedupeChain", () => {
  it("dedupes by exact model, preserving first-occurrence order", () => {
    expect(dedupeChain(["a/x", "a/y", "b/z", "a/x", "b/w"])).toEqual(["a/x", "a/y", "b/z", "b/w"]);
  });
});

describe("fallbackPlugin config hook", () => {
  it("applies the manager chain to agents without an explicit chain", async () => {
    const dataDir = fakeDataDir();
    const cfgDir = fakeConfigDir();
    isolateEnv(dataDir, cfgDir);
    saveConfig(emptyConfig(), dataDir);

    const hooks = await fallbackPlugin(
      { directory: cfgDir, client: { session: {}, tui: {} } } as any,
      {} as any,
    );
    const opencodeCfg: any = {
      agent: {
        // Has an explicit chain -> left untouched.
        build: { model: "iit/deepseek-v4-flash", fallback_models: ["opencode/big-pickle"] },
        // No chain -> gets the manager chain.
        plan: { model: "google/antigravity-gemini-3.8-flash" },
      },
    };
    await hooks.config!(opencodeCfg);
    expect(opencodeCfg.agent.build.fallback_models).toEqual(["opencode/big-pickle"]);
    expect(opencodeCfg.agent.plan.fallback_models).toEqual(managerFallbackChain());
  });
});

describe("fallbackPlugin runtime fallback on Antigravity quota error", () => {
  it("replays a chain-less Google agent on a non-Google model via the injected manager chain", async () => {
    const dataDir = fakeDataDir();
    const cfgDir = fakeConfigDir();
    isolateEnv(dataDir, cfgDir);
    saveConfig(emptyConfig(), dataDir);

    const replayed: any[] = [];
    const ctx: any = {
      directory: cfgDir,
      client: {
        session: {
          abort: async () => {},
          messages: async () => ({
            data: [{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] }],
          }),
          promptAsync: async (args: any) => {
            replayed.push(args.body.model);
          },
        },
        tui: { showToast: async () => {} },
      },
    };
    const hooks = await fallbackPlugin(ctx, {} as any);
    // Chain-less agent: the config hook must inject the manager chain.
    await hooks.config!({
      agent: {
        plan: { model: "google/antigravity-gemini-3.8-flash" },
      },
    });

    await hooks.event!({
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses-abc",
          agent: "plan",
          model: "google/antigravity-gemini-3.8-flash",
          error: {
            name: "Error",
            message:
              "Quota protection: All 2 account(s) are over 80% usage for gemini. Quota resets in 00:12:34",
          },
        },
      },
    } as any);

    expect(replayed.length).toBeGreaterThan(0);
    for (const model of replayed) {
      expect(model.providerID).not.toBe("google");
    }
  });

  it("replays a manually-switched Google build agent on a non-Google model from its explicit chain", async () => {
    const dataDir = fakeDataDir();
    const cfgDir = fakeConfigDir();
    isolateEnv(dataDir, cfgDir);
    saveConfig(emptyConfig(), dataDir);

    const replayed: any[] = [];
    const ctx: any = {
      directory: cfgDir,
      client: {
        session: {
          abort: async () => {},
          messages: async () => ({
            data: [{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] }],
          }),
          promptAsync: async (args: any) => {
            replayed.push(args.body.model);
          },
        },
        tui: { showToast: async () => {} },
      },
    };
    const hooks = await fallbackPlugin(ctx, {} as any);
    // build is configured with primary DeepSeek but the user switched to Google;
    // its explicit chain is Google -> Astra -> big-pickle.
    await hooks.config!({
      agent: {
        build: {
          model: "iit/deepseek-v4-flash",
          fallback_models: [
            "google/antigravity-gemini-3.8-flash",
            "openai/gpt-6-astra",
            "opencode/big-pickle",
          ],
        },
      },
    });

    await hooks.event!({
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses-xyz",
          agent: "build",
          model: "google/antigravity-gemini-3.8-flash",
          error: {
            name: "Error",
            message:
              "Quota protection: All 2 account(s) are over 80% usage for gemini. Quota resets in 00:12:34",
          },
        },
      },
    } as any);

    expect(replayed.length).toBeGreaterThan(0);
    for (const model of replayed) {
      expect(model.providerID).not.toBe("google");
    }
  });
});

describe("fallback engine wrap-around", () => {
  function makeCtx(replayed: any[]) {
    return {
      directory: fakeConfigDir(),
      client: {
        session: {
          abort: async () => {},
          messages: async () => ({
            data: [{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] }],
          }),
          promptAsync: async (args: any) => {
            replayed.push(args.body.model);
          },
        },
        tui: { showToast: async () => {} },
      },
    } as any;
  }

  it("wraps around to the primary when the first fallback also exhausts (cooldown 0)", async () => {
    const replayed: any[] = [];
    const hooks = await fallbackEngine(makeCtx(replayed), {
      cooldown_seconds: 0,
      fallback_models: ["openai/gpt-6-astra", "google/antigravity-gemini-3.8-flash"],
    } as any);
    await hooks.config!({
      agent: {
        build: {
          model: "openai/gpt-6-astra",
          fallback_models: ["openai/gpt-6-astra", "google/antigravity-gemini-3.8-flash"],
        },
      },
    });

    const err = (model: string) => ({
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses-wrap",
          agent: "build",
          model,
          error: { name: "Error", message: "Quota protection: All accounts over 80% usage" },
        },
      },
    } as any);

    // Primary exhausts -> first fallback.
    await hooks.event!(err("openai/gpt-6-astra"));
    expect(replayed.length).toBe(1);
    expect(replayed[0].providerID).toBe("google");

    // Simulate the fallback completing (first token + idle clears awaiting state).
    await hooks.event!({
      event: { type: "message.part.delta", properties: { sessionID: "ses-wrap", info: { model: "google/antigravity-gemini-3.8-flash" } } },
    } as any);
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses-wrap" } } } as any);

    // First fallback exhausts -> wrap around and retry the primary.
    await hooks.event!(err("google/antigravity-gemini-3.8-flash"));
    expect(replayed.length).toBe(2);
    expect(replayed[1].providerID).toBe("openai");
  });
});

describe("fallback engine routing modes", () => {
  const CHAIN = ["openai/gpt-6-astra", "google/antigravity-gemini-3.8-flash", "opencode/big-pickle"];

  function makeCtx(replayed: any[]) {
    return {
      directory: fakeConfigDir(),
      client: {
        session: {
          abort: async () => {},
          messages: async () => ({
            data: [{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] }],
          }),
          promptAsync: async (args: any) => {
            replayed.push(args.body.model);
          },
        },
        tui: { showToast: async () => {} },
      },
    } as any;
  }

  function err(model: string) {
    return {
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses-mode",
          agent: "build",
          model,
          error: { name: "Error", message: "Quota protection: All accounts over 80% usage" },
        },
      },
    } as any;
  }

  async function complete(hooks: any, model: string) {
    await hooks.event!({
      event: { type: "message.part.delta", properties: { sessionID: "ses-mode", info: { model } } },
    } as any);
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses-mode" } } } as any);
  }

  async function boot(replayed: any[], routingMode: string) {
    const hooks = await fallbackEngine(makeCtx(replayed), {
      cooldown_seconds: 0,
      routing_mode: routingMode,
      fallback_models: CHAIN,
      max_fallback_attempts: 5,
    } as any);
    await hooks.config!({
      agent: { build: { model: CHAIN[0], fallback_models: CHAIN } },
    });
    return hooks;
  }

  it("sticky never wraps back to the primary", async () => {
    const replayed: any[] = [];
    const hooks = await boot(replayed, "sticky");

    await hooks.event!(err(CHAIN[0]));
    expect(replayed.length).toBe(1);
    expect(replayed[0].providerID).toBe("google");
    await complete(hooks, CHAIN[1]);

    await hooks.event!(err(CHAIN[1]));
    expect(replayed.length).toBe(2);
    expect(replayed[1].providerID).toBe("opencode");
    await complete(hooks, CHAIN[2]);

    // Last fallback exhausts: sticky does not wrap back to the primary.
    await hooks.event!(err(CHAIN[2]));
    expect(replayed.length).toBe(2);
  });

  it("fallback-first prefers secondaries over the primary on wrap", async () => {
    const replayed: any[] = [];
    const hooks = await boot(replayed, "fallback-first");

    await hooks.event!(err(CHAIN[0]));
    expect(replayed[0].providerID).toBe("google");
    await complete(hooks, CHAIN[1]);

    await hooks.event!(err(CHAIN[1]));
    expect(replayed[1].providerID).toBe("opencode");
    await complete(hooks, CHAIN[2]);

    // Wrap: fallback-first retries a secondary (gemini), not the primary.
    await hooks.event!(err(CHAIN[2]));
    expect(replayed.length).toBe(3);
    expect(replayed[2].providerID).toBe("google");
  });

  it("round-robin wraps around to the primary", async () => {
    const replayed: any[] = [];
    const hooks = await boot(replayed, "round-robin");

    await hooks.event!(err(CHAIN[0]));
    expect(replayed[0].providerID).toBe("google");
    await complete(hooks, CHAIN[1]);

    await hooks.event!(err(CHAIN[1]));
    expect(replayed[1].providerID).toBe("opencode");
    await complete(hooks, CHAIN[2]);

    // Wrap: round-robin cycles back to the primary.
    await hooks.event!(err(CHAIN[2]));
    expect(replayed.length).toBe(3);
    expect(replayed[2].providerID).toBe("openai");
  });

  it("balanced mode picks healthiest available candidate and avoids failed models", async () => {
    const replayed: any[] = [];
    const hooks = await boot(replayed, "balanced");

    // Primary fails -> moves to gemini (index 1, never failed)
    await hooks.event!(err(CHAIN[0]));
    expect(replayed.length).toBe(1);
    expect(replayed[0].providerID).toBe("google");
    await complete(hooks, CHAIN[1]);

    // Gemini fails -> moves to big-pickle (index 2, never failed)
    await hooks.event!(err(CHAIN[1]));
    expect(replayed.length).toBe(2);
    expect(replayed[0].providerID).toBe("google");
    expect(replayed[1].providerID).toBe("opencode");
    await complete(hooks, CHAIN[2]);

    // Big-pickle fails -> both primary and gemini have failed; primary failed earlier so it is picked!
    await hooks.event!(err(CHAIN[2]));
    expect(replayed.length).toBe(3);
    expect(replayed[2].providerID).toBe("openai");
  });

  it("load-balancing and usage-based pick healthiest available candidate", async () => {
    const replayed: any[] = [];
    const hooks = await boot(replayed, "load-balancing");

    // Primary fails -> moves to gemini
    await hooks.event!(err(CHAIN[0]));
    expect(replayed.length).toBe(1);
    expect(replayed[0].providerID).toBe("google");
    await complete(hooks, CHAIN[1]);

    // Gemini fails -> moves to big-pickle
    await hooks.event!(err(CHAIN[1]));
    expect(replayed.length).toBe(2);
    expect(replayed[1].providerID).toBe("opencode");
  });

  it("latency-based routes to candidate with lowest measured latency", async () => {
    const { telemetry } = await import("../src/telemetry/index.js");
    telemetry.latency.clear();
    // Record latencies: gemini 50ms, big-pickle 10ms
    telemetry.latency.recordLatency(CHAIN[1], 50);
    telemetry.latency.recordLatency(CHAIN[2], 10);

    const replayed: any[] = [];
    const hooks = await boot(replayed, "latency-based");

    // Primary fails -> picks big-pickle (CHAIN[2]) because it has lower latency than gemini (CHAIN[1])
    await hooks.event!(err(CHAIN[0]));
    expect(replayed.length).toBe(1);
    expect(replayed[0].providerID).toBe("opencode");
  });
});

describe("fallback engine stay-on-fallback retry cap", () => {
  const CHAIN = ["openai/gpt-6-astra", "google/antigravity-gemini-3.8-flash", "opencode/big-pickle"];

  function makeCtx(replayed: any[]) {
    return {
      directory: fakeConfigDir(),
      client: {
        session: {
          abort: async () => {},
          messages: async () => ({
            data: [{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] }],
          }),
          promptAsync: async (args: any) => {
            replayed.push(args.body.model);
          },
        },
        tui: { showToast: async () => {} },
      },
    } as any;
  }

  function err(model: string) {
    return {
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses-cap",
          agent: "build",
          model,
          error: { name: "Error", message: "Quota protection: All accounts over 80% usage" },
        },
      },
    } as any;
  }

  function retry(model: string) {
    return {
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses-cap",
          agent: "build",
          model,
          status: { type: "retry", message: "The usage limit has been reached", next: Date.now() + 1000 },
        },
      },
    } as any;
  }

  async function complete(hooks: any, model: string) {
    await hooks.event!({
      event: { type: "message.part.delta", properties: { sessionID: "ses-cap", info: { model } } },
    } as any);
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses-cap" } } } as any);
  }

  it("advances to the next fallback after 5 consecutive retries on the same model", async () => {
    const replayed: any[] = [];
    const hooks = await fallbackEngine(makeCtx(replayed), {
      cooldown_seconds: 0,
      routing_mode: "main-first",
      fallback_models: CHAIN,
    } as any);
    await hooks.config!({
      agent: { build: { model: CHAIN[0], fallback_models: CHAIN } },
    });

    // Move onto the first fallback (gemini) via a hard error.
    await hooks.event!(err(CHAIN[0]));
    expect(replayed.length).toBe(1);
    expect(replayed[0].providerID).toBe("google");
    await complete(hooks, CHAIN[1]);

    // 4 retries stay on gemini (healthy fallback).
    for (let i = 0; i < 4; i++) {
      await hooks.event!(retry(CHAIN[1]));
      console.log("after retry", i, "replayed.length =", replayed.length);
    }
    expect(replayed.length).toBe(5);
    expect(replayed[4].providerID).toBe("google");

    // 5th retry exceeds the cap -> gemini marked failed, advance to big-pickle.
    await hooks.event!(retry(CHAIN[1]));
    expect(replayed.length).toBe(6);
    expect(replayed[5].providerID).toBe("opencode");
  });
});

