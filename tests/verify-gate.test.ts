import { describe, it, expect } from "vitest";
import { accept } from "../src/model-router/verify/gate.js";
import type { Artefact, Delegation, GateDeps } from "../src/model-router/verify/gate.js";
import type { DoD } from "../src/model-router/verify/dod.js";

describe("model-router/verify/gate.ts", () => {
  const dummyArtefact: Artefact = {
    changedFiles: [{ path: "src/index.ts", status: "modified" }],
    finalReturnText: "Task completed",
    declaredOutputs: ["src/index.ts"],
    producerSessionID: "sess-prod-1",
    producerTier: "fast",
  };

  const createDummyDeps = (opts?: {
    deterministicPass?: boolean;
    checkerPass?: boolean;
  }): GateDeps => ({
    deterministic: {
      cwd: "/repo",
      fs: {
        fileExists: async () => true,
        readFile: async () => "{}",
      },
      exec: async () => ({
        code: opts?.deterministicPass ?? true ? 0 : 1,
        stdout: opts?.deterministicPass ?? true ? "OK" : "ERR",
        stderr: "",
        timedOut: false,
      }),
    },
    checker: {
      dispatchGrader: async () => {
        const pass = opts?.checkerPass ?? true;
        const reasons = pass ? ["looks good"] : ["criteria failed"];
        return {
          pass,
          reasons,
          graderTier: "heavy",
          sessionID: "sess-grader-1",
          text: JSON.stringify({ pass, reasons }),
        };
      },
    },
  });

  it("bypasses verification when require is 'never'", async () => {
    const delegation: Delegation = {
      dod: {
        kind: "deterministic",
        checks: [{ kind: "fileExists", path: "foo.txt" }],
        criteria: [],
        deliverable: null,
        source: "explicit",
      },
    };
    const deps: GateDeps = {
      ...createDummyDeps(),
      require: "never",
    };

    const res = await accept(delegation, dummyArtefact, deps);
    expect(res.accepted).toBe(true);
    expect(res.verdict.skipped).toBe(true);
    expect(res.verdict.reasons).toContain("verification disabled (verify.require=never)");
  });

  it("skips verification for trivial delegations with inferred DoD", async () => {
    const delegation: Delegation = {
      trivial: true,
      dod: {
        kind: "deterministic",
        checks: [{ kind: "buildPasses" }],
        criteria: [],
        deliverable: null,
        source: "inferred",
      },
    };

    const res = await accept(delegation, dummyArtefact, createDummyDeps());
    expect(res.accepted).toBe(true);
    expect(res.verdict.skipped).toBe(true);
    expect(res.verdict.reasons[0]).toContain("trivial dispatch; verification skipped (auto-inferred DoD)");
  });

  it("honors explicit DoD even on trivial delegations", async () => {
    const delegation: Delegation = {
      trivial: true,
      dod: {
        kind: "deterministic",
        checks: [{ kind: "fileExists", path: "real.txt" }],
        criteria: [],
        deliverable: null,
        source: "explicit",
      },
    };

    const res = await accept(delegation, dummyArtefact, createDummyDeps({ deterministicPass: true }));
    expect(res.accepted).toBe(true);
    expect(res.verdict.skipped).toBeUndefined();
    expect(res.verdict.method).toBe("deterministic");
  });

  it("rejects non-trivial delegation with no checkable DoD (mode A & mode B)", async () => {
    const dodNone: DoD = {
      kind: "none",
      checks: [],
      criteria: [],
      deliverable: null,
      source: "none",
    };

    const modeBRes = await accept(
      { dod: dodNone, mode: "modeB", trivial: false },
      dummyArtefact,
      createDummyDeps()
    );
    expect(modeBRes.accepted).toBe(false);
    expect(modeBRes.verdict.reasons[0]).toContain("Mode B is strict");

    const modeARes = await accept(
      { dod: dodNone, mode: "modeA", trivial: false },
      dummyArtefact,
      createDummyDeps()
    );
    expect(modeARes.accepted).toBe(false);
    expect(modeARes.verdict.reasons[0]).toContain("Mode A");
  });

  it("accepts trivial delegation with no checkable DoD", async () => {
    const dodNone: DoD = {
      kind: "none",
      checks: [],
      criteria: [],
      deliverable: null,
      source: "none",
    };

    const res = await accept(
      { dod: dodNone, trivial: true },
      dummyArtefact,
      createDummyDeps()
    );
    expect(res.accepted).toBe(true);
    expect(res.verdict.skipped).toBe(true);
    expect(res.verdict.reasons[0]).toContain("trivial dispatch; verification skipped");
  });

  it("gates deterministic checks properly on pass and fail", async () => {
    const dod: DoD = {
      kind: "deterministic",
      checks: [{ kind: "run", command: "npm test" }],
      criteria: [],
      deliverable: null,
      source: "explicit",
    };

    const passRes = await accept(
      { dod },
      dummyArtefact,
      createDummyDeps({ deterministicPass: true })
    );
    expect(passRes.accepted).toBe(true);
    expect(passRes.verdict.pass).toBe(true);

    const failRes = await accept(
      { dod },
      dummyArtefact,
      createDummyDeps({ deterministicPass: false })
    );
    expect(failRes.accepted).toBe(false);
    expect(failRes.verdict.pass).toBe(false);
  });

  it("gates checker criteria properly on pass and fail", async () => {
    const dod: DoD = {
      kind: "checker",
      checks: [],
      criteria: ["The response must summarize the changes"],
      deliverable: null,
      source: "annotation",
    };

    const passRes = await accept(
      { dod },
      dummyArtefact,
      createDummyDeps({ checkerPass: true })
    );
    expect(passRes.accepted).toBe(true);
    expect(passRes.verdict.pass).toBe(true);

    const failRes = await accept(
      { dod },
      dummyArtefact,
      createDummyDeps({ checkerPass: false })
    );
    expect(failRes.accepted).toBe(false);
    expect(failRes.verdict.pass).toBe(false);
  });
});
