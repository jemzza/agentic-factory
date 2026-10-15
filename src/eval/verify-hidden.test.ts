import { describe, expect, it } from "vitest";
import { evaluateVerification } from "./verify-hidden.js";

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
