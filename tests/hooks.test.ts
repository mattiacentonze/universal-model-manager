import { describe, expect, it } from "vitest";
import { composeHooks } from "../src/hooks/compose.js";

describe("composeHooks preserves the full hook surface", () => {
  it("chains event-style hooks from every source", async () => {
    const calls: string[] = [];
    const hooks = composeHooks(
      {
        config: async () => { calls.push("openai-config"); },
        "chat.headers": async () => { calls.push("openai-headers"); },
        "command.execute.before": async () => { calls.push("openai-cmd"); },
      },
      {
        config: async () => { calls.push("web-config"); },
        "command.execute.before": async () => { calls.push("web-cmd"); },
      },
      {
        event: async () => { calls.push("fallback-event"); },
        "tool.execute.after": async () => { calls.push("fallback-tool"); },
      }
    );

    expect(typeof hooks.config).toBe("function");
    expect(typeof hooks["chat.headers"]).toBe("function");
    expect(typeof hooks["command.execute.before"]).toBe("function");
    expect(typeof hooks.event).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");

    await hooks.config!({} as any);
    await hooks["chat.headers"]!({} as any, {} as any);
    await hooks["command.execute.before"]!({} as any, {} as any);
    await hooks.event!({} as any);
    await hooks["tool.execute.after"]!({} as any, {} as any);

    expect(calls).toContain("openai-config");
    expect(calls).toContain("web-config");
    expect(calls).toContain("openai-cmd");
    expect(calls).toContain("web-cmd");
    expect(calls).toContain("openai-headers");
    expect(calls).toContain("fallback-event");
    expect(calls).toContain("fallback-tool");
  });

  it("fails when multiple provider-scoped objects (auth) are composed", () => {
    expect(() =>
      composeHooks({ auth: { provider: "openai", methods: [] } as any }, { auth: { provider: "antigravity", methods: [] } as any })
    ).toThrow(/multiple auth/i);
  });

  it("merges tool registrations from every source and detects duplicate names", () => {
    const hooks = composeHooks(
      { tool: { "tool-a": { __execute: "a" } as any } },
      { tool: { "tool-b": { __execute: "b" } as any } }
    );
    expect(Object.keys(hooks.tool ?? {})).toEqual(["tool-a", "tool-b"]);
    expect(() =>
      composeHooks({ tool: { dup: 1 as any } }, { tool: { dup: 2 as any } })
    ).toThrow(/duplicate composed tool/i);
  });

  it("does not drop dispose and experimental.chat.messages.transform from any source", async () => {
    const calls: string[] = [];
    const hooks = composeHooks(
      {
        dispose: async () => { calls.push("d1"); },
        "experimental.chat.messages.transform": async () => { calls.push("t1"); },
      },
      {
        dispose: async () => { calls.push("d2"); },
        "experimental.chat.messages.transform": async () => { calls.push("t2"); },
      }
    );
    await hooks.dispose!();
    await hooks["experimental.chat.messages.transform"]!({} as any, {} as any);
    expect(calls).toEqual(["d1", "d2", "t1", "t2"]);
  });

  it("returns empty hooks when no sources are provided", () => {
    const hooks = composeHooks();
    expect(hooks.auth).toBeUndefined();
    expect(hooks.config).toBeUndefined();
  });
});
