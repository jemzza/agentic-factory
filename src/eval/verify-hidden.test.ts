import { describe, expect, it } from "vitest";
import { evaluateVerification, rulesTestIssues } from "./verify-hidden.js";

describe("evaluateVerification", () => {
  it("accepts implementable tasks that fail on baseline and pass on reference", () => {
    expect(
      evaluateVerification({
        expected: "implemented",
        baselinePassed: false,
        referencePassed: true,
      }),
    ).toMatchObject({ ok: true });
  });

  it.each([
    [{ baselinePassed: true, referencePassed: true }, /baseline/],
    [{ baselinePassed: false, referencePassed: false }, /reference implementation fails/],
    [{ baselinePassed: false, referencePassed: null }, /missing/],
  ])("rejects implementable task %j", (input, reason) => {
    const out = evaluateVerification({ expected: "implemented", ...input });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(reason);
  });

  it("accepts clarification tasks whose guard tests pass on baseline without a reference", () => {
    expect(
      evaluateVerification({
        expected: "needs_clarification",
        baselinePassed: true,
        referencePassed: null,
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects clarification tasks with failing guards or a reference patch", () => {
    expect(
      evaluateVerification({
        expected: "needs_clarification",
        baselinePassed: false,
        referencePassed: null,
      }).ok,
    ).toBe(false);
    expect(
      evaluateVerification({
        expected: "needs_clarification",
        baselinePassed: true,
        referencePassed: true,
      }).ok,
    ).toBe(false);
  });
});

describe("rulesTestIssues", () => {
  const rules = "x.rules.hidden.test.ts";
  const c = (title: string, status: string, file = rules) => ({ file, title, status });

  it("accepts rules tests that fail on baseline and guards that pass", () => {
    expect(
      rulesTestIssues("implemented", [
        c("rejects an unknown key", "failed"),
        c("[guard] status filter still works", "passed"),
      ]),
    ).toEqual([]);
  });

  it("flags a non-guard rules test that passes on baseline", () => {
    const issues = rulesTestIssues("implemented", [c("404 for unknown id", "passed")]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/passes on baseline/);
  });

  it("flags a guard that fails on baseline", () => {
    expect(rulesTestIssues("implemented", [c("[guard] DELETE is 204", "failed")])[0]).toMatch(
      /guard but fails/,
    );
  });

  it("never accepts skipped or todo tests", () => {
    expect(rulesTestIssues("implemented", [c("x", "skipped"), c("y", "todo")])).toHaveLength(2);
  });

  it("requires every rules test of a clarification task to be a passing guard", () => {
    expect(rulesTestIssues("needs_clarification", [c("[guard] a", "passed")])).toEqual([]);
    expect(rulesTestIssues("needs_clarification", [c("b", "passed")])[0]).toMatch(
      /must be a \[guard\]/,
    );
  });

  it("ignores tests outside rules files (they keep the per-task rule)", () => {
    expect(rulesTestIssues("implemented", [c("old test", "passed", "x.hidden.test.ts")])).toEqual(
      [],
    );
  });
});
