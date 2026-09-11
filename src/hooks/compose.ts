import type { Hooks } from "@opencode-ai/plugin";

type Fn = (...args: any[]) => any;
type HookKey = keyof Hooks;

/** Merge multiple plugin hook results, preserving every surface (no drops). */
export function composeHooks(...results: Array<Partial<Hooks> | undefined>): Hooks {
  const out: Hooks = {};
  const chain = <K extends Extract<HookKey, string>>(key: K) => {
    const fns = results.filter(r => typeof r?.[key] === "function").map(r => r![key] as Fn);
    return fns.length
      ? (async (...args: any[]) => {
          for (const fn of fns) await fn(...args);
        }) as Hooks[K]
      : undefined;
  };

  const keys = new Set(results.flatMap(result => Object.keys(result ?? {})));
  for (const key of keys) {
    const values = results.map(result => (result as Record<string, unknown> | undefined)?.[key]).filter(value => value !== undefined);
    if (values.every(value => typeof value === "function")) {
      (out as any)[key] = chain(key as HookKey);
    } else if (key === "tool") {
      const tools: Record<string, unknown> = {};
      for (const value of values) for (const [name, definition] of Object.entries(value as Record<string, unknown>)) {
        if (name in tools) throw new Error(`Duplicate composed tool: ${name}`);
        tools[name] = definition;
      }
      out.tool = tools as Hooks["tool"];
    } else {
      if (values.length > 1) throw new Error(`Cannot compose multiple ${key} hooks; register provider plugins separately`);
      (out as any)[key] = values[0];
    }
  }

  return out;
}
