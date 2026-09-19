import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { reconcileConfigured } from "../src/manager/auth-status.js";
import { handleManagerCommand } from "../src/manager/index.js";
import {
  ANTIGRAVITY_ACCOUNT_FILE,
  accountIdFor,
  getAccounts,
  getAntigravityAccounts,
  getOpenAIAccounts,
  loginActionFor,
  OPENAI_ACCOUNT_FILE,
  OPENAI_STATE_FILE,
  reorderAntigravityAccounts,
  reorderByManagerIds,
  reorderOpenAIAccounts,
  setAntigravityMain,
  setMainByManagerId,
} from "../src/manager/provider-accounts.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "acc-"));
}

function writeOpenAI(dir: string, payload: unknown): void {
  writeFileSync(join(dir, OPENAI_ACCOUNT_FILE), `${JSON.stringify(payload)}\n`);
}
function writeOpenAIState(dir: string, payload: unknown): void {
  writeFileSync(join(dir, OPENAI_STATE_FILE), `${JSON.stringify(payload)}\n`);
}
function writeAnti(dir: string, payload: unknown): void {
  writeFileSync(join(dir, ANTIGRAVITY_ACCOUNT_FILE), `${JSON.stringify(payload)}\n`);
}

/** Production-shape OpenAI config: NO credentials, separate `main` + state file. */
const openAIConfig = (accounts: unknown[], mainAccountId?: string) => ({
  version: 1,
  main: { type: "opencode", provider: "openai" },
  routing: { mode: "main-first" },
  mainAccountId,
  accounts,
});
const oaAcct = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  accountId: id,
  type: "oauth" as const,
  enabled: true,
  ...over,
});
const oaState = (creds: Record<string, { refresh: string; expires: number }>) => ({
  version: 1,
  accounts: creds,
});

const antiStore = (accounts: unknown[], activeIndex: number) => ({
  version: 4,
  activeIndex,
  activeIndexByFamily: { claude: activeIndex, gemini: activeIndex },
  accounts,
});
const anti = (email: string | undefined, over: Record<string, unknown> = {}) => ({
  email,
  refreshToken: `rt-${email ?? "nomail"}`,
  addedAt: 1,
  lastUsed: 1,
  enabled: true,
  ...over,
});

describe("OpenAI provider account adapter (production-shaped store)", () => {
  it("lists a SEPARATE main row plus fallbacks, configured from the state store", () => {
    const dir = tmpDir();
    // main account is NOT among the fallback accounts.
    writeOpenAI(dir, openAIConfig([oaAcct("fb1"), oaAcct("fb2")], "main1"));
    writeOpenAIState(
      dir,
      oaState({
        fb1: { refresh: "rt-fb1", expires: 4_100_000_000_000 },
        fb2: { refresh: "rt-fb2", expires: 4_100_000_000_000 },
      }),
    );
    const accs = getOpenAIAccounts(dir);
    const main = accs.find((a) => a.main)!;
    const fallbacks = accs.filter((a) => !a.main);
    expect(main.email).toBe("main1");
    expect(main.configured).toBe(true); // main slot present (host auth owns creds)
    expect(fallbacks.map((a) => a.email).sort()).toEqual(["fb1", "fb2"]);
    expect(fallbacks.every((a) => a.configured)).toBe(true);
  });

  it("does NOT leak state-store credentials (separate store, no refresh in config)", () => {
    const dir = tmpDir();
    writeOpenAI(dir, openAIConfig([oaAcct("fb1")], "main1"));
    writeOpenAIState(
      dir,
      oaState({
        main1: { refresh: "SECRET-MAIN", expires: 4_100_000_000_000 },
        fb1: { refresh: "SECRET-FB1", expires: 4_100_000_000_000 },
      }),
    );
    const json = JSON.stringify(getOpenAIAccounts(dir));
    expect(json).not.toContain("SECRET-MAIN");
    expect(json).not.toContain("SECRET-FB1");
    // config file itself carries no refresh tokens
    expect(readFileSync(join(dir, OPENAI_ACCOUNT_FILE), "utf8")).not.toContain("refresh");
  });

  it("fails closed on missing/corrupt store (no fabricated accounts)", () => {
    const dir = tmpDir();
    writeOpenAI(dir, { version: 1, accounts: "nope" });
    expect(getOpenAIAccounts(dir)).toEqual([]);
    writeOpenAI(dir, { notAStore: true });
    expect(getOpenAIAccounts(dir)).toEqual([]);
    expect(getOpenAIAccounts(join(tmpDir(), "missing"))).toEqual([]);
  });

  it("reports disabled/expired fallbacks without counting them configured", () => {
    const dir = tmpDir();
    writeOpenAI(dir, openAIConfig([oaAcct("off", { enabled: false }), oaAcct("fb1")], "main1"));
    writeOpenAIState(
      dir,
      oaState({
        off: { refresh: "rt-off", expires: 4_100_000_000_000 },
        fb1: { refresh: "rt-fb1", expires: 4_100_000_000_000 },
      }),
    );
    const off = getOpenAIAccounts(dir).find((a) => a.email === "off");
    expect(off?.configured).toBe(false);
    expect(off?.disabled).toBe(true);
  });
});

describe("Antigravity provider account adapter", () => {
  it("enumerates real accounts with the activeIndex account flagged main", () => {
    const dir = tmpDir();
    writeAnti(dir, antiStore([anti("a@x"), anti("b@x")], 1));
    const accs = getAntigravityAccounts(dir);
    expect(accs).toHaveLength(2);
    expect(accs.find((a) => a.main)?.email).toBe("b@x");
    expect(accs.map((a) => a.configured).sort()).toEqual([true, true]);
  });

  it("never leaks a raw refresh token, including email-less accounts", () => {
    const dir = tmpDir();
    writeAnti(
      dir,
      antiStore([{ email: undefined, refreshToken: "REAL-SECRET-TOKEN", addedAt: 1, lastUsed: 1, enabled: true }], 0),
    );
    const accs = getAntigravityAccounts(dir);
    const json = JSON.stringify(accs);
    expect(json).not.toContain("REAL-SECRET-TOKEN");
    expect(json).not.toContain("rt-");
    expect(accs[0].configured).toBe(true);
    expect(accs[0].id).toBe(accountIdFor("antigravity", accountIdFor("antigravity", "REAL-SECRET-TOKEN")));
  });

  it("setAntigravityMain updates the real activeIndex (locked) and unknown ids fail closed", async () => {
    const dir = tmpDir();
    writeAnti(dir, antiStore([anti("a@x"), anti("b@x")], 0));
    const b = getAntigravityAccounts(dir).find((a) => a.email === "b@x")!;
    const res = await setAntigravityMain(dir, b.id);
    expect(res.kind).toBe("applied");
    const stored = JSON.parse(readFileSync(join(dir, ANTIGRAVITY_ACCOUNT_FILE), "utf8"));
    expect(stored.activeIndex).toBe(1);
    expect(getAntigravityAccounts(dir).find((a) => a.main)?.email).toBe("b@x");
    const invalid = await setAntigravityMain(dir, "does-not-exist");
    expect(invalid.kind).toBe("invalid");
  });

  it("reorderAntigravityAccounts preserves main and family indices; rejects duplicates", async () => {
    const dir = tmpDir();
    writeAnti(dir, antiStore([anti("a@x"), anti("b@x"), anti("c@x")], 1));
    const ids = getAntigravityAccounts(dir).map((a) => a.id);
    const res = await reorderAntigravityAccounts(dir, [ids[2], ids[0], ids[1]]);
    expect(res.kind).toBe("applied");
    const stored = JSON.parse(readFileSync(join(dir, ANTIGRAVITY_ACCOUNT_FILE), "utf8"));
    expect(stored.accounts.map((a: { email?: string }) => a.email)).toEqual(["c@x", "a@x", "b@x"]);
    expect(stored.activeIndex).toBe(2); // b@x moved to index 2
    expect(stored.activeIndexByFamily.claude).toBe(2);
    expect(stored.activeIndexByFamily.gemini).toBe(2);

    // Duplicate permutation must fail closed (no partial write).
    const before = readFileSync(join(dir, ANTIGRAVITY_ACCOUNT_FILE), "utf8");
    const dup = await reorderAntigravityAccounts(dir, [ids[0], ids[0], ids[1]]);
    expect(dup.kind).toBe("invalid");
    expect(readFileSync(join(dir, ANTIGRAVITY_ACCOUNT_FILE), "utf8")).toBe(before);
  });

  it("marks ineligible/verification accounts disabled (not configured)", () => {
    const dir = tmpDir();
    writeAnti(
      dir,
      antiStore([anti("a@x"), anti("b@x", { enabled: false }), anti("c@x", { accountIneligible: true })], 0),
    );
    const accs = getAntigravityAccounts(dir);
    expect(accs.find((a) => a.email === "b@x")?.disabled).toBe(true);
    expect(accs.find((a) => a.email === "c@x")?.disabled).toBe(true);
    expect(accs.find((a) => a.email === "a@x")?.disabled).toBe(false);
  });

  it("fails closed on corrupt/non-v4 store", () => {
    const dir = tmpDir();
    writeAnti(dir, { version: 3, accounts: [] });
    expect(getAntigravityAccounts(dir)).toEqual([]);
    expect(getAntigravityAccounts(join(tmpDir(), "missing"))).toEqual([]);
  });
});

describe("Unified manager-facing interface", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
    writeOpenAI(dir, openAIConfig([oaAcct("a"), oaAcct("b")], "main1"));
    writeOpenAIState(
      dir,
      oaState({
        a: { refresh: "rt-a", expires: 4_100_000_000_000 },
        b: { refresh: "rt-b", expires: 4_100_000_000_000 },
      }),
    );
    writeAnti(dir, antiStore([anti("a@x"), anti("b@x")], 1));
  });

  it("getAccounts enumerates separate main + fallbacks across providers by safe names", () => {
    const all = getAccounts(dir);
    const serialized = JSON.stringify(all);
    expect(serialized).not.toContain("rt-");
    expect(all.every((a) => /^(openai|antigravity)-[0-9a-z]+$/.test(a.id))).toBe(true);
    const openaiMain = all.find((a) => a.provider === "openai" && a.main);
    const antiMain = all.find((a) => a.provider === "antigravity" && a.main);
    expect(openaiMain?.email).toBe("main1");
    expect(antiMain?.email).toBe("b@x");
  });

  it("reconcileConfigured preserves user-chosen account aliases by kind+label", () => {
    const real = getAccounts(dir);
    const stored = real.map((r) => ({
      id: r.id,
      kind: r.provider,
      label: r.label,
      alias: r.label === "a@x" ? "work" : undefined,
      main: r.main,
      configured: r.configured,
    }));
    const reconciled = reconcileConfigured(stored, dir);
    expect(reconciled.find((a) => a.label === "a@x")?.alias).toBe("work");
    expect(reconciled.find((a) => a.label === "b@x")?.alias).toBeUndefined();
  });

  it("setMainByManagerId: antigravity applies, OpenAI primary delegates (no false success)", async () => {
    const other = getAntigravityAccounts(dir).find((a) => !a.main)!;
    const applied = await setMainByManagerId(dir, other.id);
    expect(applied.kind).toBe("applied");
    expect(getAntigravityAccounts(dir).find((a) => a.main)?.email).toBe(other.email);

    // OpenAI primary cannot be swapped from config; delegate to native, never claim success.
    const openaiAny = getOpenAIAccounts(dir).find((a) => !a.main)!;
    const delegated = await setMainByManagerId(dir, openaiAny.id);
    expect(delegated.kind).toBe("delegate");
    if (delegated.kind === "delegate") {
      expect(delegated.action.command).toBe("/openai-account");
    }
  });

  it("reorderByManagerIds rejects ids spanning providers and duplicate permutations", async () => {
    const oaAll = getAccounts(dir)
      .filter((a) => a.provider === "openai")
      .map((a) => a.id);
    const anti = getAccounts(dir)
      .filter((a) => a.provider === "antigravity")
      .map((a) => a.id);
    expect((await reorderByManagerIds(dir, [oaAll[0], anti[0]])).kind).toBe("invalid");
    expect((await reorderByManagerIds(dir, [anti[0], anti[0]])).kind).toBe("invalid");
    // Valid single-provider permutation of the reorderable OpenAI fallbacks delegates to native.
    const oaFallbacks = getOpenAIAccounts(dir)
      .filter((a) => !a.main)
      .map((a) => a.id);
    const res = await reorderByManagerIds(dir, [oaFallbacks[1], oaFallbacks[0]]);
    expect(["applied", "delegate"]).toContain(res.kind);
  });

  it("reorderOpenAIAccounts validates the permutation and emits a native swap action", async () => {
    writeOpenAI(dir, openAIConfig([oaAcct("a"), oaAcct("b"), oaAcct("c")], "main1"));
    writeOpenAIState(
      dir,
      oaState({
        a: { refresh: "rt-a", expires: 4_100_000_000_000 },
        b: { refresh: "rt-b", expires: 4_100_000_000_000 },
        c: { refresh: "rt-c", expires: 4_100_000_000_000 },
      }),
    );
    const fallbacks = getOpenAIAccounts(dir)
      .filter((a) => !a.main)
      .map((a) => a.id);
    // Reorder [a,b,c] -> [c,b,a] (a full permutation incl. non-adjacent swap).
    const res = await reorderOpenAIAccounts(dir, [fallbacks[2], fallbacks[1], fallbacks[0]]);
    expect(res.kind).toBe("delegate");
    if (res.kind === "delegate") {
      expect(res.action.kind).toBe("reorder");
      expect(res.action.cli).toEqual({ command: "", args: [] });
      // Every swap names two distinct reorderable ids.
      for (const pair of res.action.text.split("; ")) {
        const [x, y] = pair.replace("/openai-account order ", "").split(" ");
        expect(x).not.toBe(y);
      }
    }
    // Duplicate permutation fails closed.
    const dup = await reorderOpenAIAccounts(dir, [fallbacks[0], fallbacks[0], fallbacks[1]]);
    expect(dup.kind).toBe("invalid");
  });

  it("loginActionFor returns real supported commands (TUI + CLI argv)", () => {
    const oa = loginActionFor("openai");
    expect(oa.command).toBe("/openai-account");
    expect(oa.arguments).toBe("add");
    expect(oa.cli).toEqual({ command: "openai-auth", args: ["login"] });

    const ag = loginActionFor("antigravity");
    expect(ag.command).toBe("/google-account");
    expect(ag.arguments).toBe("add-oauth-start");
    expect(ag.cli).toEqual({ command: "antigravity-auth", args: ["login"] });

    const cw = loginActionFor("chatgpt-web");
    expect(cw.cli).toEqual({ command: "universal-auth", args: ["login", "chatgpt-web"] });
  });
});

describe("Manager account commands drive the real stores (async)", () => {
  let configDir: string;
  let dir: string;
  beforeEach(() => {
    configDir = tmpDir();
    dir = tmpDir();
    writeOpenAI(configDir, openAIConfig([oaAcct("a"), oaAcct("b")], "main1"));
    writeOpenAIState(
      configDir,
      oaState({
        a: { refresh: "rt-a", expires: 4_100_000_000_000 },
        b: { refresh: "rt-b", expires: 4_100_000_000_000 },
      }),
    );
    writeAnti(configDir, antiStore([anti("a@x"), anti("b@x")], 1));
  });

  it("/u-main sets the real Antigravity main; OpenAI primary delegates", async () => {
    const other = getAntigravityAccounts(configDir).find((a) => !a.main)!;
    const res = await handleManagerCommand("u-main", other.id, dir, configDir);
    expect(res?.text).toContain("now the real main");
    expect(getAntigravityAccounts(configDir).find((a) => a.main)?.email).toBe(other.email);

    const oaAny = getOpenAIAccounts(configDir).find((a) => !a.main)!;
    const oaRes = await handleManagerCommand("u-main", oaAny.id, dir, configDir);
    expect(oaRes?.action?.command).toBe("/openai-account");
    expect(oaRes?.text).toContain("OpenAI");
  });

  it("/u-accounts reorder mutates the real Antigravity roster; rejects invalid reorders", async () => {
    const ids = getAntigravityAccounts(configDir).map((a) => a.id);
    const res = await handleManagerCommand("u-accounts", `reorder ${ids[1]} ${ids[0]}`, dir, configDir);
    expect(res?.text).toContain("updated");
    expect(getAntigravityAccounts(configDir).map((a) => a.email)).toEqual(["b@x", "a@x"]);
    const bad = await handleManagerCommand("u-accounts", `reorder ${ids[0]} ${ids[0]}`, dir, configDir);
    expect(bad?.text).toContain("Invalid reorder");
  });

  it("/u-accounts add returns a login action and never fakes configured", async () => {
    const res = await handleManagerCommand("u-accounts", "add openai Work", dir, configDir);
    expect(res?.action?.command).toBe("/openai-account");
    // No fake configured account is appended to the real store by an add.
    expect(getOpenAIAccounts(configDir).some((a) => a.label === "Work")).toBe(false);
  });
});
