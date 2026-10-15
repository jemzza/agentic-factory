import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../config/load-config.js";
import { findHiddenArtifacts } from "../eval/hidden-guard.js";
import { git } from "../git/git.js";
import type { TargetRepo } from "../git/target-repo.js";
import { FACTORY_ROOT, HIDDEN_DIR } from "../paths.js";
import type { SandboxExec } from "../quality/gate.js";
import type { AgentRunInput, AgentRunResult, AgentRuntime } from "../runtimes/types.js";
import type { PlannerOutput, ReviewVerdict } from "../schemas/agents.js";
import type { TaskSpec } from "../schemas/task.js";
import { openDb } from "../store/db.js";
import { importRunReports } from "../store/import-runs.js";
import { Store } from "../store/store.js";
import { runTask } from "./run-task.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-pipeline-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const TASK: TaskSpec = {
  id: "add-feature",
  title: "Add feature",
  request: "Add a feature.",
  acceptance_criteria: ["feature exists", "feature is tested"],
  scope: { allowed_paths: ["src/**", "tests/**"] },
  budget: { max_fix_cycles: 2, max_cost_usd: 1, timeout_minutes: 15 },
};

const PLAN: PlannerOutput = {
  plan: "Create src/feature.ts",
  files_to_change: ["src/feature.ts"],
  risks: [],
  questions: [],
};

const APPROVE: ReviewVerdict = {
  verdict: "approve",
  issues: [],
  criteria_check: TASK.acceptance_criteria.map((criterion) => ({
    criterion,
    met: true,
    evidence: "src/feature.ts",
  })),
};

const REJECT: ReviewVerdict = {
  verdict: "request_changes",
  issues: [{ severity: "major", file: "src/feature.ts", description: "no edge case" }],
  criteria_check: TASK.acceptance_criteria.map((criterion, i) => ({
    criterion,
    met: i === 0,
    evidence: i === 0 ? "ok" : "missing test",
  })),
};

type Script = Partial<
  Record<
    AgentRunInput["role"],
    (input: AgentRunInput, n: number) => Promise<Partial<AgentRunResult>>
  >
>;

/** Scripted runtime: per-role handlers; records every call. */
class FakeRuntime implements AgentRuntime {
  readonly name = "fake";
  readonly calls: AgentRunInput[] = [];
  private readonly counts = new Map<string, number>();
  constructor(private readonly script: Script) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.calls.push(input);
    const n = this.counts.get(input.role) ?? 0;
    this.counts.set(input.role, n + 1);
    const handler = this.script[input.role];
    if (!handler) throw new Error(`unexpected ${input.role} call`);
    const partial = await handler(input, n);
    const logPath = input.logPath ?? path.join(tmp, "log.jsonl");
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, "{}\n");
    return {
      ok: true,
      output: "",
      durationMs: 5,
      costUsd: 0.01,
      tokens: { input: 1, output: 1 },
      numTurns: 1,
      permissionDenials: [],
      rawLogPath: logPath,
      ...partial,
    };
  }

  rolesCalled(): string[] {
    return this.calls.map((c) => c.role);
  }
}

const planner =
  (plan: PlannerOutput = PLAN) =>
  () =>
    Promise.resolve({ structured: plan, output: JSON.stringify(plan) });
const reviewer =
  (...verdicts: ReviewVerdict[]) =>
  (_: AgentRunInput, n: number) =>
    Promise.resolve({ structured: verdicts[Math.min(n, verdicts.length - 1)] });
const writeFeature = (contents: string[]) => async (input: AgentRunInput, n: number) => {
  await mkdir(path.join(input.cwd, "src"), { recursive: true });
  await writeFile(
    path.join(input.cwd, "src", "feature.ts"),
    contents[Math.min(n, contents.length - 1)] ?? "",
  );
  return { output: "Done! All checks pass." }; // never trusted
};

/** Fake sandbox: `test` fails if src/feature.ts contains BROKEN; typecheck always passes. */
const fakeExec: SandboxExec = async (wt, command) => {
  const feature = await readFile(path.join(wt, "src", "feature.ts"), "utf8").catch(() => "");
  const failing = command.includes("test") && feature.includes("BROKEN");
  return {
    exitCode: failing ? 1 : 0,
    stdout: failing ? "FAIL tests/feature.test.ts\nexpected 1 got 2" : "ok",
    stderr: "",
    durationMs: 3,
    timedOut: false,
  };
};

let repoCounter = 0;
async function makeRepo(extraFiles: Record<string, string> = {}): Promise<TargetRepo> {
  const dir = path.join(tmp, `repo-${++repoCounter}`);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), '{"name":"t"}\n');
  await writeFile(path.join(dir, "CLAUDE.md"), "# Target conventions\nUse the clock.\n");
  await writeFile(path.join(dir, "src", "index.ts"), "export {};\n");
  for (const [rel, content] of Object.entries(extraFiles)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "baseline"]);
  return { dir, baseCommit: (await git(dir, ["rev-parse", "HEAD"])).trim() };
}

function config(): ResolvedConfig {
  return {
    workdir: tmp,
    workdirAbs: tmp,
    target: {
      name: "t",
      source: { kind: "fixture", path: "unused" },
      install: ["true"],
      checks: [
        { name: "typecheck", command: ["npm", "run", "typecheck"] },
        { name: "test", command: ["npm", "test"] },
      ],
      conventionsFile: "CLAUDE.md",
    },
    models: { planner: "p-model", developer: "d-model", reviewer: "r-model" },
    stepTimeoutsMinutes: { planner: 1, developer: 1, reviewer: 1, check: 1 },
    maxDiffCharsForReview: 100_000,
  };
}

async function run(
  script: Script,
  opts: { task?: TaskSpec; exec?: SandboxExec; repo?: TargetRepo; store?: Store } = {},
) {
  const runtime = new FakeRuntime(script);
  const repo = opts.repo ?? (await makeRepo());
  const result = await runTask(opts.task ?? TASK, {
    config: config(),
    runtime,
    runsDir: path.join(tmp, "runs"),
    ensureRepo: () => Promise.resolve(repo),
    makeSandboxExec: () => Promise.resolve(opts.exec ?? fakeExec),
    ...(opts.store ? { store: opts.store } : {}),
  });
  return { ...result, runtime, repo };
}

describe("runTask", () => {
  it("succeeds when the gate passes and the reviewer approves; writes reports with the real diff", async () => {
    const { report, reportJsonPath, reportMdPath, runtime } = await run({
      planner: planner(),
      developer: writeFeature(["export const feature = 1;\n"]),
      reviewer: reviewer(APPROVE),
    });
    expect(report.status).toBe("success");
    expect(report.fixCycles).toBe(0);
    expect(runtime.rolesCalled()).toEqual(["planner", "developer", "reviewer"]);
    expect(report.changedFiles).toEqual(["src/feature.ts"]);
    expect(report.diff).toContain("+export const feature = 1;");
    expect(report.gate?.checks.map((c) => c.command.join(" "))).toEqual([
      "npm run typecheck",
      "npm test",
    ]);
    expect(report.cost.totalUsd).toBeCloseTo(0.03);
    expect(JSON.parse(await readFile(reportJsonPath, "utf8"))).toMatchObject({ status: "success" });
    const md = await readFile(reportMdPath, "utf8");
    expect(md).toContain("`success`");
    expect(md).toContain("$ npm test");
    expect(md).toContain("+export const feature = 1;");
  });

  it("works in an isolated worktree on a factory branch, outside the factory repo", async () => {
    const { report, repo } = await run({
      planner: planner(),
      developer: writeFeature(["export const feature = 1;\n"]),
      reviewer: reviewer(APPROVE),
    });
    const wt = report.worktree;
    expect(wt?.branch).toMatch(/^factory\/add-feature-/);
    expect(path.relative(FACTORY_ROOT, wt?.path ?? "")).toMatch(/^\.\./);
    // The main checkout is untouched.
    await expect(access(path.join(repo.dir, "src", "feature.ts"))).rejects.toThrow();
    expect(await findHiddenArtifacts(wt?.path ?? "")).toEqual([]);
  });

  it("gives the reviewer only the task and diff, never the developer's message", async () => {
    const { runtime } = await run({
      planner: planner(),
      developer: writeFeature(["export const feature = 1;\n"]),
      reviewer: reviewer(APPROVE),
    });
    const reviewCall = runtime.calls.find((c) => c.role === "reviewer");
    expect(reviewCall?.prompt).toContain("+export const feature = 1;");
    expect(reviewCall?.prompt).toContain("feature is tested");
    expect(reviewCall?.prompt).not.toContain("All checks pass");
    expect(reviewCall?.allowedTools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("injects the target's conventions and uses per-role models and tools", async () => {
    const { runtime } = await run({
      planner: planner(),
      developer: writeFeature(["export const feature = 1;\n"]),
      reviewer: reviewer(APPROVE),
    });
    for (const call of runtime.calls) expect(call.systemPrompt).toContain("Use the clock.");
    expect(runtime.calls.map((c) => c.model)).toEqual(["p-model", "d-model", "r-model"]);
    expect(runtime.calls[0]?.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(runtime.calls[1]?.allowedTools).toContain("Bash(npm run check)");
    expect(runtime.calls[0]?.outputSchema).toBeDefined();
  });

  it("stops with needs_clarification when the planner asks questions", async () => {
    const { report, runtime } = await run({
      planner: planner({ ...PLAN, questions: ["Hard delete contradicts 410 for deleted tasks?"] }),
    });
    expect(report.status).toBe("needs_clarification");
    expect(runtime.rolesCalled()).toEqual(["planner"]);
    expect(report.plan?.questions).toHaveLength(1);
  });

  it("runs a fix cycle with the gate's failures, snapshotting before each cycle", async () => {
    const { report, runtime } = await run({
      planner: planner(),
      developer: writeFeature(["BROKEN\n", "export const feature = 2;\n"]),
      reviewer: reviewer(APPROVE),
    });
    expect(report.status).toBe("success");
    expect(report.fixCycles).toBe(1);
    expect(runtime.rolesCalled()).toEqual(["planner", "developer", "developer", "reviewer"]);
    const fixPrompt = runtime.calls[2]?.prompt ?? "";
    expect(fixPrompt).toContain("Fix cycle 1 of 2");
    expect(fixPrompt).toContain("expected 1 got 2");
    expect(report.steps.filter((s) => s.kind === "snapshot")).toHaveLength(2);
  });

  it("ends with gate_failed after the maximum number of fix cycles", async () => {
    const { report, runtime } = await run({
      planner: planner(),
      developer: writeFeature(["BROKEN 1\n", "BROKEN 2\n", "BROKEN 3\n"]),
    });
    expect(report.status).toBe("gate_failed");
    expect(report.fixCycles).toBe(2);
    expect(runtime.rolesCalled().filter((r) => r === "developer")).toHaveLength(3);
  });

  it("ends with review_rejected and passes reviewer findings to the developer", async () => {
    const { report, runtime } = await run({
      planner: planner(),
      developer: writeFeature(["a\n", "b\n", "c\n"]),
      reviewer: reviewer(REJECT),
    });
    expect(report.status).toBe("review_rejected");
    expect(report.fixCycles).toBe(2);
    const fixPrompt = runtime.calls.filter((c) => c.role === "developer")[1]?.prompt ?? "";
    expect(fixPrompt).toContain("no edge case");
    expect(fixPrompt).toContain("missing test");
  });

  it("does not accept an approve that contradicts the reviewer's own findings", async () => {
    const inconsistent: ReviewVerdict = { ...REJECT, verdict: "approve" };
    const { report } = await run(
      {
        planner: planner(),
        developer: writeFeature(["a\n"]),
        reviewer: reviewer(inconsistent),
      },
      { task: { ...TASK, budget: { ...TASK.budget, max_fix_cycles: 0 } } },
    );
    expect(report.status).toBe("review_rejected");
  });

  it("fails the gate on changes outside allowed paths", async () => {
    const { report, runtime } = await run(
      {
        planner: planner(),
        developer: async (input) => {
          await writeFile(path.join(input.cwd, "package.json"), '{"name":"hacked"}\n');
          return {};
        },
      },
      { task: { ...TASK, budget: { ...TASK.budget, max_fix_cycles: 0 } } },
    );
    expect(report.status).toBe("gate_failed");
    expect(report.gate?.scope.violations).toEqual(["package.json"]);
    expect(runtime.rolesCalled()).not.toContain("reviewer");
  });

  it("fails the gate when the developer changes nothing", async () => {
    const { report } = await run(
      { planner: planner(), developer: () => Promise.resolve({}) },
      { task: { ...TASK, budget: { ...TASK.budget, max_fix_cycles: 0 } } },
    );
    expect(report.status).toBe("gate_failed");
    expect(report.gate?.scope.empty).toBe(true);
  });

  it("stops with budget_exceeded as soon as spending passes the budget", async () => {
    const { report, runtime } = await run({
      planner: () => Promise.resolve({ structured: PLAN, costUsd: 0.6 }),
      developer: async (input, n) => ({ ...(await writeFeature(["x\n"])(input, n)), costUsd: 0.6 }),
      reviewer: reviewer(APPROVE),
    });
    expect(report.status).toBe("budget_exceeded");
    expect(report.cost.totalUsd).toBeCloseTo(1.2);
    expect(runtime.rolesCalled()).toEqual(["planner", "developer"]);
    // The developer was given only the remaining budget.
    expect(runtime.calls[1]?.maxBudgetUsd).toBeCloseTo(0.4);
  });

  it("maps a runtime budget error to budget_exceeded", async () => {
    const { report } = await run({
      planner: () =>
        Promise.resolve({
          ok: false,
          costUsd: 1.05,
          error: { kind: "budget", message: "Reached maximum budget" },
        }),
    });
    expect(report.status).toBe("budget_exceeded");
  });

  it("maps an agent timeout to timeout and counts unknown cost", async () => {
    const { report } = await run({
      planner: planner(),
      developer: () => {
        const r: Partial<AgentRunResult> = {
          ok: false,
          error: { kind: "timeout", message: "no finish" },
        };
        return Promise.resolve(Object.assign(r, { costUsd: undefined }));
      },
    });
    expect(report.status).toBe("timeout");
    expect(report.cost.unknownCostSteps).toBe(1);
  });

  it("treats an invalid planner answer as a step error, not something to guess", async () => {
    const { report, runtime } = await run({
      planner: () => Promise.resolve({ structured: { plan: "x" } }), // missing fields
    });
    expect(report.status).toBe("error");
    expect(report.message).toMatch(/invalid_response/);
    expect(runtime.rolesCalled()).toEqual(["planner"]);
  });

  it("treats a reviewer that skips criteria as a step error", async () => {
    const { report } = await run({
      planner: planner(),
      developer: writeFeature(["a\n"]),
      reviewer: reviewer({ ...APPROVE, criteria_check: APPROVE.criteria_check.slice(0, 1) }),
    });
    expect(report.status).toBe("error");
    expect(report.message).toMatch(/expected exactly 2/);
  });

  it("maps an agent process crash to error with the message", async () => {
    const { report } = await run({
      planner: () =>
        Promise.resolve({ ok: false, error: { kind: "process", message: "exited with code 3" } }),
    });
    expect(report.status).toBe("error");
    expect(report.message).toContain("exited with code 3");
  });

  it("reports sandbox infrastructure failures as error, not as a failed check", async () => {
    const { report } = await run(
      {
        planner: planner(),
        developer: writeFeature(["a\n"]),
      },
      {
        exec: () =>
          Promise.resolve({
            exitCode: 125,
            stdout: "",
            stderr: "",
            durationMs: 1,
            timedOut: false,
            infraError: "docker down",
          }),
      },
    );
    expect(report.status).toBe("error");
    expect(report.message).toContain("sandbox failure: docker down");
  });

  it("refuses to run if hidden eval artifacts are present in the target repo", async () => {
    const hiddenFile = path.join(HIDDEN_DIR, "complete-task", "complete-task.hidden.test.ts");
    const repo = await makeRepo({ "tests/innocent.test.ts": await readFile(hiddenFile, "utf8") });
    const { report, runtime } = await run({ planner: planner() }, { repo });
    expect(report.status).toBe("error");
    expect(report.message).toMatch(/hidden eval artifacts/);
    expect(runtime.calls).toHaveLength(0);
  });
});

describe("hidden tests never reach agent worktrees", () => {
  it("the guard detects hidden tests by content and by name", async () => {
    const dir = path.join(tmp, "guard");
    await mkdir(path.join(dir, "tests"), { recursive: true });
    await writeFile(path.join(dir, "tests", "ok.test.ts"), "test('x', () => {});\n");
    expect(await findHiddenArtifacts(dir)).toEqual([]);
    await copyFile(
      path.join(HIDDEN_DIR, "pagination", "pagination.hidden.test.ts"),
      path.join(dir, "tests", "renamed.test.ts"),
    );
    await writeFile(path.join(dir, "tests", "_harness.ts"), "different content\n");
    expect((await findHiddenArtifacts(dir)).sort()).toEqual([
      path.join("tests", "_harness.ts"),
      path.join("tests", "renamed.test.ts"),
    ]);
  });
});

describe("runTask with the database", () => {
  it("records the run, every step and the final status; report files remain artifacts", async () => {
    const db = openDb(path.join(tmp, "with-db.sqlite"));
    const store = new Store(db);
    try {
      const { report, reportMdPath } = await run(
        {
          planner: planner(),
          developer: writeFeature(["BROKEN\n", "export const feature = 2;\n"]),
          reviewer: reviewer(APPROVE),
        },
        { store },
      );
      const row = store.requireRun(report.runId);
      expect(row).toMatchObject({
        status: "success",
        mode: "interactive",
        fix_cycles: 1,
        report_path: reportMdPath,
        branch: report.worktree?.branch,
        head_commit: report.worktree?.headCommit,
      });
      expect(row.cost_usd).toBeCloseTo(report.cost.totalUsd);
      expect(row.roles_json["reviewer"]).toEqual({ runtime: "fake", model: "r-model" });
      expect(store.listSteps(report.runId).map((s) => [s.node, s.cycle, s.status])).toEqual([
        ["planner", 0, "ok"],
        ["developer", 0, "ok"],
        ["gate", 0, "failed"],
        ["developer", 1, "ok"],
        ["gate", 1, "ok"],
        ["reviewer", 1, "ok"],
      ]);
      expect(store.listEvents(report.runId).at(-1)).toMatchObject({ kind: "status" });
    } finally {
      db.close();
    }
  });

  it("records a failed run with the error status and abandons the interrupted step", async () => {
    const db = openDb(path.join(tmp, "with-db-err.sqlite"));
    const store = new Store(db);
    try {
      const { report } = await run(
        { planner: planner(), developer: writeFeature(["a\n"]) },
        {
          store,
          exec: () =>
            Promise.resolve({
              exitCode: 125,
              stdout: "",
              stderr: "",
              durationMs: 1,
              timedOut: false,
              infraError: "docker down",
            }),
        },
      );
      expect(store.requireRun(report.runId)).toMatchObject({ status: "error" });
      expect(store.listSteps(report.runId).at(-1)).toMatchObject({
        node: "gate",
        status: "abandoned",
      });
    } finally {
      db.close();
    }
  });

  it("imports Week 1 report.json files once (re-import skips them)", async () => {
    const runsDir = path.join(tmp, "runs");
    const { report } = await run({
      planner: planner(),
      developer: writeFeature(["export const feature = 1;\n"]),
      reviewer: reviewer(APPROVE),
    });
    const db = openDb(path.join(tmp, "import.sqlite"));
    const store = new Store(db);
    try {
      const first = await importRunReports(store, runsDir);
      expect(first.invalid).toEqual([]);
      expect(first.imported).toContain(report.runId);
      expect(store.requireRun(report.runId)).toMatchObject({
        status: "success",
        task_id: "add-feature",
      });
      expect(store.listSteps(report.runId).map((s) => s.node)).toEqual([
        "planner",
        "developer",
        "gate",
        "reviewer",
      ]);
      const again = await importRunReports(store, runsDir);
      expect(again.imported).toEqual([]);
      expect(again.skipped).toContain(report.runId);
    } finally {
      db.close();
    }
  });
});
