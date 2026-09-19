import { describe, expect, it } from "vitest";
import { buildAgentConfig } from "../src/manager/operations.js";
import { emptyConfig, tierTargets } from "../src/manager/store.js";
import { managerRouterHooks, routerProtocol } from "../src/router/index.js";

function opencodeConfig(): any {
  return { agent: { build: { prompt: "keep", model: "a/b" }, fast: { model: "some/other" } } };
}

describe("managerRouterHooks registers manager-owned routing", () => {
  it("applies the flat agent map and preserves unrelated user fields", async () => {
    const cfg = opencodeConfig();
    const settings = emptyConfig().router;
    await managerRouterHooks(settings).config?.(cfg);

    expect(cfg.agent.build.model).toBe(settings.orchestrator);
    expect(cfg.agent.build.prompt).toBe("keep"); // preserved
    expect(cfg.agent.build.mode).toBe("primary");
    expect(cfg.agent.fast.model).toBe(settings.tiers.fast.model);
    expect(cfg.agent.medium?.model).toBe("openai/gpt-6-astra");
    expect(cfg.agent.medium?.variant).toBe("medium");
    expect(cfg.agent.heavy?.fallback_models).toContain("google/antigravity-gemini-3.8-flash");
    // Same models as the standalone flat map (single source of truth).
    expect(cfg.agent.medium?.model).toBe(buildAgentConfig(settings).medium?.model);
  });

  it("injects the routing protocol with explicit tier tags into the system prompt", async () => {
    const settings = emptyConfig().router;
    const output: any = { system: [] as string[] };
    await managerRouterHooks(settings)["experimental.chat.system.transform"]?.({} as any, output);
    const text = output.system.join("\n");
    expect(text).toContain("[tier:fast]");
    expect(text).toContain("[tier:medium]");
    expect(text).toContain("[tier:heavy]");
    expect(text).toContain(settings.tiers.medium.model);
  });

  it("enforces an explicit [tier:X] tag on task dispatch via subagent_type", async () => {
    const settings = emptyConfig().router;
    const hooks = managerRouterHooks(settings);
    const output: any = { args: { subagent_type: "medium", prompt: "do a thing" } };
    await hooks["tool.execute.before"]?.({ tool: "task" } as any, output);
    expect(output.args.prompt).toContain("[tier:medium]");
    expect(output.args.prompt).toContain("do a thing");
  });

  it("applies the selected variant options from the actual model catalog", async () => {
    const settings = emptyConfig().router;
    const hooks = managerRouterHooks(settings);
    const medium = settings.tiers.medium; // gpt-6-astra variant medium, gemini fallback medium
    const output: any = { options: {} };
    await hooks["chat.params"]?.(
      {
        agent: "medium",
        model: {
          id: medium.model,
          providerID: "openai",
          variants: { medium: { reasoning_effort: "medium" }, high: { reasoning_effort: "high" } },
        },
        provider: { info: { id: "openai" } },
      } as any,
      output,
    );
    expect(output.options.reasoning_effort).toBe("medium");
  });

  it("does not merge foreign/unknown variant options", async () => {
    const settings = emptyConfig().router;
    const hooks = managerRouterHooks(settings);
    const output: any = { options: {} };
    // Model is not in any configured chain -> no variant applied.
    await hooks["chat.params"]?.(
      {
        agent: "custom",
        model: { id: "unrelated/x", variants: { high: { top_k: 1 } } },
        provider: { info: { id: "x" } },
      } as any,
      output,
    );
    expect(output.options).toEqual({});
    // Known chain but a model variant the catalog does not declare -> no merge.
    const deepseek: any = { options: {} };
    await hooks["chat.params"]?.(
      { agent: "fast", model: { id: "iit/deepseek-v4-flash", variants: {} }, provider: { info: { id: "iit" } } } as any,
      deepseek,
    );
    expect(deepseek.options).toEqual({});
  });
});

describe("disabled routing registers no protocol/guard/tier agents", () => {
  it("returns empty hooks when routing is disabled", async () => {
    const settings = { ...emptyConfig().router, enabled: false };
    const hooks = managerRouterHooks(settings);
    expect(hooks).toEqual({});
  });
});

describe("routerProtocol and tierTargets", () => {
  it("reads legacy fallback + fallbackVariants into ordered {model, variant} targets", () => {
    const chain = {
      model: "openai/gpt-6-astra",
      variant: "medium",
      fallback: ["google/antigravity-gemini-3.8-flash", "iit/deepseek-v4-flash"],
      fallbackVariants: { "google/antigravity-gemini-3.8-flash": "medium" },
    };
    const targets = tierTargets(chain);
    expect(targets[0]).toEqual({ model: "google/antigravity-gemini-3.8-flash", variant: "medium" });
    expect(targets[1]).toEqual({ model: "iit/deepseek-v4-flash", variant: undefined });
  });

  it("uses explicit targets when present", () => {
    const chain = { model: "m/x", fallback: ["a"], targets: [{ model: "z/y", variant: "high" }] };
    expect(tierTargets(chain)).toEqual([{ model: "z/y", variant: "high" }]);
  });

  it("protocol lists tier purposes", () => {
    const text = routerProtocol(emptyConfig().router);
    expect(text).toContain("read-only");
    expect(text).toContain("implementation");
    expect(text).toContain("architecture");
  });
});
