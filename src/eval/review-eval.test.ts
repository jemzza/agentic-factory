import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewVerdict } from "../schemas/agents.js";
import { FakeRuntime } from "../testing/fakes.js";
import { loadReviewCases, type ReviewCase } from "./review-cases.js";
import {
  renderReviewEvalMarkdown,
  reviewerMetrics,
  runReviewEval,
  scoreCase,
} from "./review-eval.js";
import { loadEvalStand } from "./stand.js";
import { loadTaskSpec } from "./tasks.js";

let tmp: string;
let cases: ReviewCase[];
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-review-eval-"));
  cases = await loadReviewCases();
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const byId = (id: string) => {
  const c = cases.find((x) => x.id.startsWith(id));
  if (!c) throw new Error(id);
  return c;
};
const verdict = (v: Partial<ReviewVerdict> & { criteria?: number }): ReviewVerdict => ({
  verdict: v.verdict ?? "approve",
  issues: v.issues ?? [],
  criteria_check: Array.from({ length: v.criteria ?? 1 }, (_, i) => ({
    criterion: `c${i}`,
    met: v.verdict !== "request_changes",
    evidence: "e",
  })),
});

describe("scoreCase (rules from evals/review/README.md)", () => {
  it("counts a defect as found only with a blocker/major issue on the defect's file", () => {
    const d01 = byId("d01");
    const onFile = verdict({
      verdict: "request_changes",
      issues: [
        {
          severity: "blocker",
          file: "src/services/task-service.ts",
          description: "no deleted check",
        },
      ],
    });
    const wrongFile = verdict({
      verdict: "request_changes",
      issues: [{ severity: "major", file: "src/routes/tasks.ts", description: "x" }],
    });
    const minorOnly = verdict({
      verdict: "request_changes",
      issues: [{ severity: "minor", file: "src/services/task-service.ts", description: "x" }],
    });
    expect(scoreCase(d01, onFile, null)).toEqual({ flagged: true, found: true, error: null });
    const withLines = verdict({
      verdict: "request_changes",
      issues: [
        { severity: "blocker", file: "src/services/task-service.ts:73-78", description: "x" },
      ],
    });
    expect(scoreCase(d01, withLines, null)).toMatchObject({ found: true });
    expect(scoreCase(d01, wrongFile, null)).toEqual({ flagged: true, found: false, error: null });
    expect(scoreCase(d01, minorOnly, null)).toMatchObject({ flagged: true, found: false });
    expect(scoreCase(d01, verdict({}), null)).toEqual({
      flagged: false,
      found: false,
      error: null,
    });
    expect(scoreCase(d01, null, "parse: no JSON")).toEqual({
      flagged: false,
      found: false,
      error: "parse: no JSON",
    });
  });

  it("a clean case is a false positive when not approved; minor issues alone do not count", () => {
    const c01 = byId("c01");
    expect(
      scoreCase(
        c01,
        verdict({ issues: [{ severity: "minor", file: "a", description: "nit" }] }),
        null,
      ).flagged,
    ).toBe(false);
    expect(scoreCase(c01, verdict({ verdict: "request_changes" }), null).flagged).toBe(true);
  });
});

describe("runReviewEval", () => {
  it("reviews real cases on a fresh baseline copy and scores two reviewers", async () => {
    const subset = [byId("c01"), byId("d01"), byId("d04")];
    // The case's diff is committed in the reviewer's working copy and shown in the prompt.
    const sharpAnswer = (prompt: string): ReviewVerdict => {
      if (prompt.includes("package.json")) {
        return verdict({
          verdict: "request_changes",
          criteria: 5,
          issues: [{ severity: "major", file: "package.json", description: "out of scope" }],
        });
      }
      if (prompt.includes("findById(id)")) {
        return verdict({
          verdict: "request_changes",
          criteria: 3,
          issues: [
            { severity: "blocker", file: "src/services/task-service.ts", description: "deleted" },
          ],
        });
      }
      return verdict({ criteria: 3 });
    };
    const sharp = new FakeRuntime({
      reviewer: (input) => Promise.resolve({ structured: sharpAnswer(input.prompt) }),
    });
    let calls = 0;
    const lenient = new FakeRuntime({
      reviewer: (input) => {
        calls++;
        // First answer for every case is invalid → one retry, then approve everything.
        if (!input.prompt.includes("Your previous answer could not be used"))
          return Promise.resolve({ structured: { nope: true } });
        const criteria = (input.prompt.match(/^\d+\. /gm) ?? []).length;
        return Promise.resolve({ structured: verdict({ criteria }) });
      },
    });
    const stand = await loadEvalStand();
    const results = await runReviewEval({
      cases: subset,
      reviewers: [
        { label: "sharp", runtime: sharp, model: "m1" },
        { label: "lenient", runtime: lenient, model: "m2" },
      ],
      loadTask: loadTaskSpec,
      baselineSource: stand.fixtureDir,
      projectConfig: stand.projectConfig,
      outDir: tmp,
      maxDiffChars: 100_000,
      timeoutMs: 10_000,
    });
    expect(results["sharp"]?.map((s) => [s.caseId.slice(0, 3), s.found, s.flagged])).toEqual([
      ["c01", false, false],
      ["d01", true, true],
      ["d04", true, true],
    ]);
    expect(reviewerMetrics("sharp", results["sharp"] ?? [])).toMatchObject({
      recall: 1,
      falsePositiveRate: 0,
      errors: 0,
    });
    expect(reviewerMetrics("lenient", results["lenient"] ?? [])).toMatchObject({
      recall: 0,
      falsePositiveRate: 0,
      retries: 3,
    });
    expect(calls).toBe(6);
    const md = renderReviewEvalMarkdown("review-eval-test", results);
    expect(md).toContain("| sharp | **100%** (2/2)");
    expect(md).toContain("❌ missed");
  }, 120_000);
});
