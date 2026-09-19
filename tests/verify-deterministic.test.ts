import { describe, expect, it } from "vitest";
import {
  createMutexRegistry,
  DEFAULT_ALLOWLIST,
  FORBIDDEN_SHELL,
  isCommandAllowed,
  runDeterministic,
  shapeMismatch,
} from "../src/model-router/verify/deterministic.js";
import type { DoD } from "../src/model-router/verify/dod.js";
import type { DeterministicDeps } from "../src/model-router/verify/types.js";

describe("model-router/verify/deterministic.ts", () => {
  describe("createMutexRegistry", () => {
    it("serializes execution for the same key", async () => {
      const mutex = createMutexRegistry();
      const events: string[] = [];

      const p1 = mutex.runExclusive("k1", async () => {
        events.push("start:p1");
        await new Promise((r) => setTimeout(r, 10));
        events.push("end:p1");
        return 1;
      });

      const p2 = mutex.runExclusive("k1", async () => {
        events.push("start:p2");
        events.push("end:p2");
        return 2;
      });

      const res = await Promise.all([p1, p2]);
      expect(res).toEqual([1, 2]);
      expect(events).toEqual(["start:p1", "end:p1", "start:p2", "end:p2"]);
    });

    it("does not deadlock when previous task rejects", async () => {
      const mutex = createMutexRegistry();

      await expect(
        mutex.runExclusive("k1", async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow("fail");

      const res = await mutex.runExclusive("k1", async () => "recovered");
      expect(res).toBe("recovered");
    });
  });

  describe("command allowlist & shell detection", () => {
    it("detects forbidden shell metacharacters", () => {
      expect(FORBIDDEN_SHELL.test("npm test; rm -rf /")).toBe(true);
      expect(FORBIDDEN_SHELL.test("npm test && ls")).toBe(true);
      expect(FORBIDDEN_SHELL.test("npm test | grep foo")).toBe(true);
      expect(FORBIDDEN_SHELL.test("npm test > output.txt")).toBe(true);
      expect(FORBIDDEN_SHELL.test("npm run `whoami`")).toBe(true);
      expect(FORBIDDEN_SHELL.test("npm test $(whoami)")).toBe(true);
      expect(FORBIDDEN_SHELL.test("npm run\nkill")).toBe(true);
    });

    it("validates commands against allowlist", () => {
      expect(isCommandAllowed("npm test", DEFAULT_ALLOWLIST)).toBe(true);
      expect(isCommandAllowed("npx vitest run", DEFAULT_ALLOWLIST)).toBe(true);
      expect(isCommandAllowed("node ./dist/index.js", DEFAULT_ALLOWLIST)).toBe(true);
      expect(isCommandAllowed("/usr/bin/npm test", DEFAULT_ALLOWLIST)).toBe(true);

      // Not allowlisted binary
      expect(isCommandAllowed("rm -rf foo", DEFAULT_ALLOWLIST)).toBe(false);
      expect(isCommandAllowed("curl http://example.com", DEFAULT_ALLOWLIST)).toBe(false);

      // Shell chaining forbidden
      expect(isCommandAllowed("npm test && npm run build", DEFAULT_ALLOWLIST)).toBe(false);

      // Disallow inline interpreter eval flags
      expect(isCommandAllowed("node -e 'console.log(1)'", DEFAULT_ALLOWLIST)).toBe(false);
      expect(isCommandAllowed("node -p 'process.env'", DEFAULT_ALLOWLIST)).toBe(false);
      expect(isCommandAllowed("node --eval 'process.exit(1)'", DEFAULT_ALLOWLIST)).toBe(false);
      expect(isCommandAllowed("bun -e 'console.log(1)'", DEFAULT_ALLOWLIST)).toBe(false);
    });
  });

  describe("shapeMismatch", () => {
    it("returns null when shapes match", () => {
      const schema = { a: "string", b: 123, c: [1] };
      const target = { a: "val", b: 456, c: [2, 3], extra: true };
      expect(shapeMismatch(schema, target)).toBeNull();
    });

    it("detects missing keys or type mismatches", () => {
      expect(shapeMismatch({ a: "string" }, {})).toBe("a: missing");
      expect(shapeMismatch({ a: "string" }, { a: 123 })).toBe("a.: expected string, got number");
      expect(shapeMismatch({ a: { b: 1 } }, { a: { b: "not number" } })).toBe("a.b.: expected number, got string");
      expect(shapeMismatch([1], "not an array")).toBe("<root>: expected array");
      expect(shapeMismatch({ a: 1 }, "not an object")).toBe("<root>: expected object");
    });
  });

  describe("runDeterministic", () => {
    it("skips when no checks are provided", async () => {
      const dod: DoD = {
        kind: "deterministic",
        checks: [],
        criteria: [],
        deliverable: null,
        source: "explicit",
      };
      const deps: DeterministicDeps = {
        cwd: "/app",
        fs: { fileExists: async () => true, readFile: async () => "" },
        exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
      };

      const verdict = await runDeterministic(dod, deps);
      expect(verdict.pass).toBe(false);
      expect(verdict.skipped).toBe(true);
      expect(verdict.method).toBe("none");
    });

    it("passes fileExists check when file exists", async () => {
      const dod: DoD = {
        kind: "deterministic",
        checks: [{ kind: "fileExists", path: "package.json" }],
        criteria: [],
        deliverable: null,
        source: "explicit",
      };
      const deps: DeterministicDeps = {
        cwd: "/app",
        fs: {
          fileExists: async (p) => p === "/app/package.json",
          readFile: async () => "",
        },
        exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
      };

      const verdict = await runDeterministic(dod, deps);
      expect(verdict.pass).toBe(true);
      expect(verdict.method).toBe("deterministic");
      expect(verdict.reasons).toEqual(["all 1 deterministic checks passed"]);
    });

    it("fails fileExists check when file does not exist", async () => {
      const dod: DoD = {
        kind: "deterministic",
        checks: [{ kind: "fileExists", path: "missing.json" }],
        criteria: [],
        deliverable: null,
        source: "explicit",
      };
      const deps: DeterministicDeps = {
        cwd: "/app",
        fs: { fileExists: async () => false, readFile: async () => "" },
        exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
      };

      const verdict = await runDeterministic(dod, deps);
      expect(verdict.pass).toBe(false);
      expect(verdict.reasons[0]).toContain("file not found in /app: missing.json");
    });

    it("runs run/testsPass commands and handles expected substrings or errors", async () => {
      const dod: DoD = {
        kind: "deterministic",
        checks: [
          { kind: "run", command: "npm test", expect: "PASS" },
          { kind: "testsPass", command: "npm test" },
        ],
        criteria: [],
        deliverable: null,
        source: "explicit",
      };

      const deps: DeterministicDeps = {
        cwd: "/app",
        fs: { fileExists: async () => true, readFile: async () => "" },
        exec: async () => ({ code: 0, stdout: "PASS: all tests passed", stderr: "", timedOut: false }),
      };

      const verdict = await runDeterministic(dod, deps);
      expect(verdict.pass).toBe(true);
    });

    it("detects command failure and non-allowlisted command", async () => {
      const dod: DoD = {
        kind: "deterministic",
        checks: [{ kind: "run", command: "bash -c 'evil'" }],
        criteria: [],
        deliverable: null,
        source: "explicit",
      };

      const deps: DeterministicDeps = {
        cwd: "/app",
        fs: { fileExists: async () => true, readFile: async () => "" },
        exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
      };

      const verdict = await runDeterministic(dod, deps);
      expect(verdict.pass).toBe(false);
      expect(verdict.reasons[0]).toContain("command not allowlisted");
    });

    it("verifies schemaMatch check", async () => {
      const dod: DoD = {
        kind: "deterministic",
        checks: [{ kind: "schemaMatch", path: "data.json", schema: '{"version": 1}' }],
        criteria: [],
        deliverable: null,
        source: "explicit",
      };

      const deps: DeterministicDeps = {
        cwd: "/app",
        fs: {
          fileExists: async () => true,
          readFile: async (p) => (p === "/app/data.json" ? '{"version": 1, "extra": true}' : ""),
        },
        exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
      };

      const verdict = await runDeterministic(dod, deps);
      expect(verdict.pass).toBe(true);

      // Now with invalid json target
      const failDeps: DeterministicDeps = {
        cwd: "/app",
        fs: {
          fileExists: async () => true,
          readFile: async () => "invalid json",
        },
        exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
      };
      const failVerdict = await runDeterministic(dod, failDeps);
      expect(failVerdict.pass).toBe(false);
      expect(failVerdict.reasons[0]).toContain("target is not valid JSON");
    });
  });
});
