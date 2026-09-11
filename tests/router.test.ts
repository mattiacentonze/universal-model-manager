import { describe, expect, it } from "vitest";
import { managerRouterHooks } from "../src/router/index.js";
import type { RouterSettings } from "../src/manager/types.js";

function makeSettings(): RouterSettings {
  return {
    orchestrator: "openai/gpt-5.2",
    enabled: true,
    tiers: {
      fast: { model: "google/antigravity-gemini-3.8-flash", variant: "medium", fallback: [] },
      medium: { model: "openai/gpt-6-astra", variant: "high", fallback: ["google/antigravity-gemini-3.8-flash"], targets: [{ model: "google/antigravity-gemini-3.8-flash", variant: "medium" }] },
      heavy: { model: "openai/gpt-6-astra", variant: "low", fallback: [] },
    },
  };
}

type F = { id: string; providerID: string; provider: string; variants?: Record<string, Record<string, unknown>> };

function chatParams(s: RouterSettings, agent: string, model: F) {
  const output: { options: Record<string, unknown> } = { options: {} };
  const hook = (managerRouterHooks(s) as Record<string, unknown>)["chat.params"];
  return (hook as (input: unknown, output: { options: Record<string, unknown> }) => Promise<void>)
    .call(null, { agent, model }, output)
    .then(() => output.options);
}

describe("managerRouterHooks variant lookup (chat.params)", () => {
  it("resolves a bare id against the manager's tier chain model", async () => {
    const model: F = { id: "gpt-6-astra", providerID: "openai", provider: "openai", variants: { high: { reasoningEffort: "high" }, low: { reasoningEffort: "low" } } };
    expect(await chatParams(makeSettings(), "medium", model)).toEqual({ reasoningEffort: "high" });
  });

  it("resolves an actual Gemini fallback id (providerID + bare id) to its fallback variant", async () => {
    const model: F = { id: "antigravity-gemini-3.8-flash", providerID: "google", provider: "google", variants: { medium: { thinking: true } } };
    expect(await chatParams(makeSettings(), "medium", model)).toEqual({ thinking: true });
  });

  it("resolves different variants for the same model across medium vs heavy", async () => {
    const settings = makeSettings();
    const model: F = { id: "gpt-6-astra", providerID: "openai", provider: "openai", variants: { high: { reasoningEffort: "high" }, low: { reasoningEffort: "low" } } };
    expect(await chatParams(settings, "medium", model)).toEqual({ reasoningEffort: "high" });
    expect(await chatParams(settings, "heavy", model)).toEqual({ reasoningEffort: "low" });
  });

  it("leaves options untouched for an unrelated agent (not a manager tier)", async () => {
    const model: F = { id: "gpt-6-astra", providerID: "openai", provider: "openai", variants: { high: { reasoningEffort: "high" } } };
    expect(await chatParams(makeSettings(), "build", model)).toEqual({});
  });
});

describe("managerRouterHooks explicit task tier tag (tool.execute.before)", () => {
  type ToolOutput = { args?: { prompt?: string; subagent_type?: string } };
  const toolHook = (s: RouterSettings) => (managerRouterHooks(s) as Record<string, unknown>)["tool.execute.before"];
  const runTool = async (s: RouterSettings, tool: string, output: ToolOutput) => {
    await (toolHook(s) as (data: unknown, output: ToolOutput) => Promise<void>).call(null, { tool }, output);
    return output;
  };

  it("honors an explicit [tier:...] tag by setting the task subagent_type", async () => {
    const out = await runTool(makeSettings(), "task", { args: { prompt: "refactor a module [tier:heavy]" } });
    expect(out.args?.subagent_type).toBe("heavy");
  });

  it("does not touch non-task tool calls", async () => {
    const out = await runTool(makeSettings(), "read", { args: { prompt: "[tier:medium] read the file", subagent_type: "general" } });
    expect(out.args?.subagent_type).toBe("general");
  });

  it("without an explicit tag, tags a declared tier subagent_type into the prompt", async () => {
    const out = await runTool(makeSettings(), "task", { args: { prompt: "do the work", subagent_type: "medium" } });
    expect(out.args?.prompt).toContain("[tier:medium]");
    expect(out.args?.subagent_type).toBe("medium");
  });
});
