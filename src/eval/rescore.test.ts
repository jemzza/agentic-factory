import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../git/git.js";
import { exportTree } from "../git/target-repo.js";
import type { HiddenTestResult } from "./hidden-tests.js";
import { aggregate, RepeatedSummarySchema } from "./repeat.js";
import { rescoreEval } from "./rescore.js";
import {
  computeMetrics,
  EvalSummarySchema,
  EvalTaskResultSchema,
  type EvalSummary,
  type EvalTaskResult,
} from "./run-eval.js";

let root: string;
let repo: string;
let baseline: string;

/** A diff that sets src/a.txt to `content`, as `git diff baseline..HEAD` would print it. */
async function diffTo(content: string): Promise<{ diff: string; head: string }> {
  await git(repo, ["checkout", "-q", "-B", `b-${content}`, baseline]);
  await writeFile(path.join(repo, "src", "a.txt"), `${content}\n`);
  await git(repo, ["commit", "-qam", content]);
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const diff = await git(repo, ["diff", baseline, head]);
  await git(repo, ["checkout", "-q", "main"]);
  return { diff, head };
}

function result(taskId: string, extra: Partial<EvalTaskResult>): EvalTaskResult {
  return EvalTaskResultSchema.parse({
    taskId,
    title: taskId,
    difficulty: "simple",
    expected: "implemented",
    status: "success",
    outcome: "verified",
    correct: true,
    message: "",
    fixCycles: 0,
    gateFixCycles: 0,
    reviewCycles: 0,
    firstPass: true,
    reachedDeveloper: true,
    reachedReview: true,
    durationMs: 1000,
    costUsd: 0.5,
    unknownCostSteps: 0,
    hidden: { passed: true, exitCode: 0, timedOut: false, total: 1, failed: 0, outputTail: "" },
    hiddenLeaks: [],
    reportPath: `${taskId}-run/report.md`,
    ...extra,
  });
}

async function writePass(
  dir: string,
  runs: { r: EvalTaskResult; report?: { diff: string; base: string; head: string | null } }[],
): Promise<EvalSummary> {
  for (const { r, report } of runs) {
    if (!report || r.reportPath === null) continue;
    const runDir = path.join(dir, path.dirname(r.reportPath));
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "report.json"),
      JSON.stringify({
        diff: report.diff,
        target: { name: "t", repoDir: repo, baseCommit: report.base },
        worktree: { path: "/gone", branch: "x", headCommit: report.head },
      }),
    );
  }
  const tasks = runs.map((x) => x.r);
  const summary = EvalSummarySchema.parse({
    schemaVersion: 1,
    evalId: "eval-20260101-000000",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T01:00:00.000Z",
    models: { planner: "opus" },
    runtime: "claude-code",
    metrics: computeMetrics(tasks),
    tasks,
    costCap: null,
  });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "summary.json"), JSON.stringify(summary));
  return summary;
}

/** Hidden tests pass iff src/a.txt says "good". */
const runHidden = async (tree: string): Promise<HiddenTestResult> => {
  const ok = (await readFile(path.join(tree, "src", "a.txt"), "utf8")).trim() === "good";
  return {
    passed: ok,
    exitCode: ok ? 0 : 1,
    timedOut: false,
    total: 2,
    failed: ok ? 0 : 1,
    durationMs: 5,
    outputTail: ok ? "" : "✗ rules: rejects unknown key",
  };
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rescore-test-"));
  repo = path.join(root, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "a.txt"), "base\n");
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", "baseline"]);
  baseline = (await git(repo, ["rev-parse", "HEAD"])).trim();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const deps = () => ({
  baselineCommit: baseline,
  hiddenTestsCommit: "abc123",
  materialize: (commit: string, dest: string) => exportTree(repo, commit, dest),
  runHidden: (tree: string) => runHidden(tree),
  now: () => new Date("2026-10-18T10:00:00Z"),
});

describe("rescoreEval", () => {
  it("re-judges success claims on baseline + stored diff and keeps every other outcome", async () => {
    const good = await diffTo("good");
    const bad = await diffTo("bad");
    const evalDir = path.join(root, "runs", "eval-20260101-000000");
    const r1 = await writePass(path.join(evalDir, "r1"), [
      { r: result("keeps", {}), report: { diff: good.diff, base: baseline, head: good.head } },
      { r: result("drops", {}), report: { diff: bad.diff, base: baseline, head: bad.head } },
      {
        r: result("clarify", {
          expected: "needs_clarification",
          status: "needs_clarification",
          outcome: "needs_clarification",
          firstPass: null,
          hidden: null,
          reportPath: null,
        }),
      },
    ]);
    const r2 = await writePass(path.join(evalDir, "r2"), [
      { r: result("keeps", {}), report: { diff: good.diff, base: baseline, head: good.head } },
    ]);
    const source = aggregate("eval-20260101-000000", [r1, r2], {
      repeatsPlanned: 2,
      roles: { planner: "claude-code:opus" },
      baselineCommit: baseline,
      costCapUsd: 10,
      costCapReached: false,
    });
    const sourceJson = JSON.stringify(source);
    await writeFile(path.join(evalDir, "summary.json"), sourceJson);

    const { summary, changes, outDir } = await rescoreEval(evalDir, deps());

    expect(changes).toEqual([
      {
        repeat: 1,
        taskId: "drops",
        from: "verified",
        to: "false_success",
        failures: "✗ rules: rejects unknown key",
      },
    ]);
    const [p1, p2] = summary.repeats;
    expect(p1?.tasks.map((t) => [t.taskId, t.outcome, t.firstPass, t.rescore?.source])).toEqual([
      ["keeps", "verified", true, "diff"],
      ["drops", "false_success", false, "diff"],
      ["clarify", "needs_clarification", null, undefined],
    ]);
    expect(p1?.metrics.falseSuccess).toBe(1);
    expect(p2?.metrics.verifiedRate).toBe(1);
    // Cost and time are the source eval's: nothing was re-run.
    expect(p1?.metrics.totalCostUsd).toBe(r1.metrics.totalCostUsd);
    expect(summary.rescoredFrom).toMatchObject({
      sourceEvalId: "eval-20260101-000000",
      baselineCommit: baseline,
      hiddenTestsCommit: "abc123",
    });
    // Written under rescore-<ts>/, marked as rescored; the source is untouched.
    expect(path.basename(outDir)).toBe("rescore-20261018-100000");
    const written = RepeatedSummarySchema.parse(
      JSON.parse(await readFile(path.join(outDir, "summary.json"), "utf8")),
    );
    expect(written.repeats[0]?.rescoredFrom?.sourceEvalId).toBe("eval-20260101-000000");
    expect(await readFile(path.join(outDir, "summary.md"), "utf8")).toMatch(
      /— rescored\n\n> \*\*Rescored\*\*/,
    );
    expect(await readFile(path.join(outDir, "r1", "summary.md"), "utf8")).toMatch(/Rescored/);
    expect(await readFile(path.join(outDir, "changes.md"), "utf8")).toMatch(
      /\| r1 \| `drops` \| verified \| false_success \|/,
    );
    expect(await readFile(path.join(evalDir, "summary.json"), "utf8")).toBe(sourceJson);
  });

  it("falls back to the run's head commit when the stored diff does not apply", async () => {
    const good = await diffTo("good");
    const evalDir = path.join(root, "runs", "eval-20260101-000000");
    await writePass(evalDir, [
      {
        r: result("masked", {}),
        report: { diff: "diff --git a/x b/x\nnot a patch\n", base: baseline, head: good.head },
      },
    ]);
    const { summary } = await rescoreEval(evalDir, deps());
    expect(summary.repeats[0]?.tasks[0]).toMatchObject({
      outcome: "verified",
      rescore: { source: "commit" },
    });
  });

  it("is hidden_error, never a pass, when neither the diff nor the commit can be used", async () => {
    const evalDir = path.join(root, "runs", "eval-20260101-000000");
    await writePass(evalDir, [
      // Recorded on another baseline: its head commit is not the same tree as baseline + diff.
      {
        r: result("lost", {}),
        report: { diff: "garbage\n", base: "0".repeat(40), head: baseline },
      },
    ]);
    const { summary, changes } = await rescoreEval(evalDir, deps());
    const t = summary.repeats[0]?.tasks[0];
    expect(t).toMatchObject({
      outcome: "hidden_error",
      correct: false,
      rescore: { source: "unavailable" },
    });
    expect(t?.hidden?.infraError).toMatch(/does not apply/);
    expect(changes[0]).toMatchObject({ from: "verified", to: "hidden_error" });
  });

  it("an empty diff is rescored on the bare baseline", async () => {
    const evalDir = path.join(root, "runs", "eval-20260101-000000");
    await writePass(evalDir, [
      { r: result("nothing", {}), report: { diff: "", base: baseline, head: baseline } },
    ]);
    const { summary } = await rescoreEval(evalDir, deps());
    expect(summary.repeats[0]?.tasks[0]).toMatchObject({
      outcome: "false_success",
      rescore: { source: "diff" },
    });
  });
});
