import { describe, expect, it } from "vitest";
import type { DoD } from "../src/model-router/verify/dod.js";
import {
  inferDoD,
  isCheckable,
  normalizeDoD,
  parseAcceptanceBlock,
  parseDoDFromAnnotation,
  parseDoDFromDispatch,
  summarizeDispatch,
} from "../src/model-router/verify/dod.js";

describe("model-router/verify/dod.ts", () => {
  describe("summarizeDispatch", () => {
    it("returns empty string for empty input", () => {
      expect(summarizeDispatch("")).toBe("");
    });

    it("extracts first non-empty line and collapses whitespace", () => {
      const text = "\n   \n   Fix the    login bug   now  \nsecond line";
      expect(summarizeDispatch(text)).toBe("Fix the login bug now");
    });

    it("truncates summary to 120 characters", () => {
      const longLine = "a".repeat(200);
      expect(summarizeDispatch(longLine).length).toBe(120);
    });
  });

  describe("normalizeDoD", () => {
    it("classifies kind based on checks or criteria", () => {
      const withChecks: DoD = {
        kind: "none",
        checks: [{ kind: "fileExists", path: "file.txt" }],
        criteria: [],
        deliverable: "file.txt",
        source: "explicit",
      };
      expect(normalizeDoD(withChecks).kind).toBe("deterministic");

      const withCriteria: DoD = {
        kind: "none",
        checks: [],
        criteria: ["manual check passed"],
        deliverable: null,
        source: "annotation",
      };
      expect(normalizeDoD(withCriteria).kind).toBe("checker");

      const empty: DoD = {
        kind: "checker",
        checks: [],
        criteria: [],
        deliverable: "   ",
        source: "none",
      };
      const normalizedEmpty = normalizeDoD(empty);
      expect(normalizedEmpty.kind).toBe("none");
      expect(normalizedEmpty.deliverable).toBeNull();
    });
  });

  describe("parseAcceptanceBlock & parseDoDFromDispatch / parseDoDFromAnnotation", () => {
    it("returns null when no acceptance block exists", () => {
      expect(parseAcceptanceBlock("hello world")).toBeNull();
      expect(parseAcceptanceBlock("[acceptance] unclosed block")).toBeNull();
      expect(parseDoDFromDispatch("hello world")).toBeNull();
    });

    it("parses acceptance block with [acceptance] tags", () => {
      const text = `
Here is the task.
[acceptance]
kind: deterministic
check: fileExists path="dist/index.js"
check: testsPass command="npm test"
criteria: must be clean
deliverable: dist/index.js
[/acceptance]
End of dispatch.
`;
      const dod = parseAcceptanceBlock(text, "explicit");
      expect(dod).not.toBeNull();
      expect(dod?.source).toBe("explicit");
      expect(dod?.kind).toBe("deterministic");
      expect(dod?.deliverable).toBe("dist/index.js");
      expect(dod?.criteria).toEqual(["must be clean"]);
      expect(dod?.checks).toHaveLength(2);
      expect(dod?.checks[0]).toEqual({ kind: "fileExists", path: "dist/index.js" });
      expect(dod?.checks[1]).toEqual({ kind: "testsPass", command: "npm test" });
    });

    it("parses [dod] tags and parses unquoted kv pairs", () => {
      const text = `
[dod]
check: run command="npm run lint" expect=zero_errors
check: schemaMatch path=data.json schema=schema.json
criteria: all passes
[/dod]
`;
      const dod = parseDoDFromAnnotation(text);
      expect(dod).not.toBeNull();
      expect(dod?.source).toBe("annotation");
      expect(dod?.checks).toHaveLength(2);
      expect(dod?.checks[0]).toEqual({
        kind: "run",
        command: "npm run lint",
        expect: "zero_errors",
      });
      expect(dod?.checks[1]).toEqual({
        kind: "schemaMatch",
        path: "data.json",
        schema: "schema.json",
      });
    });

    it("ignores invalid check kinds", () => {
      const text = `
[acceptance]
check: invalidKind foo=bar
check: fileExists path="valid.txt"
[/acceptance]
`;
      const dod = parseAcceptanceBlock(text);
      expect(dod?.checks).toHaveLength(1);
      expect(dod?.checks[0].kind).toBe("fileExists");
    });
  });

  describe("inferDoD", () => {
    it("infers bugfix checks from dispatch text", () => {
      const text = "Fix the broken user login regression";
      const dod = inferDoD(text, "fast", {
        testCommand: "npm test",
        buildCommand: "npm run build",
      });

      expect(dod.source).toBe("inferred");
      expect(dod.kind).toBe("deterministic");
      expect(dod.checks).toEqual([
        { kind: "buildPasses", command: "npm run build" },
        { kind: "testsPass", command: "npm test" },
      ]);
    });

    it("infers refactor checks from dispatch text", () => {
      const text = "Refactor auth helper functions";
      const dod = inferDoD(text, "medium", {
        buildCommand: "npm run build",
        lintCommand: "npm run lint",
      });

      expect(dod.kind).toBe("deterministic");
      expect(dod.checks).toEqual([
        { kind: "buildPasses", command: "npm run build" },
        { kind: "lintClean", command: "npm run lint" },
      ]);
    });

    it("infers writeFile check when declaredPath is present", () => {
      const text = "Write the new schema definition";
      const dod = inferDoD(text, "fast", {
        declaredPath: "src/schema.json",
      });

      expect(dod.kind).toBe("deterministic");
      expect(dod.checks).toEqual([{ kind: "fileExists", path: "src/schema.json" }]);
      expect(dod.deliverable).toBe("src/schema.json");
    });

    it("infers test checks from dispatch text", () => {
      const text = "Add coverage and tests for module";
      const dod = inferDoD(text, "fast", {
        testCommand: "vitest run",
      });

      expect(dod.kind).toBe("deterministic");
      expect(dod.checks).toEqual([{ kind: "testsPass", command: "vitest run" }]);
    });

    it("falls back to checker criteria when no checks are produced", () => {
      const text = "Explain how the routing works";
      const dod = inferDoD(text, "fast", {});

      expect(dod.kind).toBe("checker");
      expect(dod.checks).toEqual([]);
      expect(dod.criteria).toEqual(["Explain how the routing works"]);
    });
  });

  describe("isCheckable", () => {
    it("returns true only when kind is not none and checks or criteria exist", () => {
      expect(
        isCheckable({
          kind: "deterministic",
          checks: [{ kind: "fileExists", path: "a" }],
          criteria: [],
          deliverable: null,
          source: "explicit",
        }),
      ).toBe(true);

      expect(
        isCheckable({
          kind: "checker",
          checks: [],
          criteria: ["done"],
          deliverable: null,
          source: "annotation",
        }),
      ).toBe(true);

      expect(
        isCheckable({
          kind: "none",
          checks: [{ kind: "fileExists", path: "a" }],
          criteria: [],
          deliverable: null,
          source: "none",
        }),
      ).toBe(false);

      expect(
        isCheckable({
          kind: "deterministic",
          checks: [],
          criteria: [],
          deliverable: null,
          source: "none",
        }),
      ).toBe(false);
    });
  });
});
