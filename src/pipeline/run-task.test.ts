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
import type { TaskBudget, TaskSpec } from "../schemas/task.js";
import { openDb } from "../store/db.js";
import { importRunReports } from "../store/import-runs.js";
import { writeFirstPass } from "../report/first-pass.js";
import { ClaudeCodeRuntime } from "../runtimes/claude-code.js";
import { Store } from "../store/store.js";
import {
  FAKE_PLAN,
  FAKE_PROJECT,
  FAKE_PROJECT_CONFIG_YAML,
  OPENSPEC_SKELETON,
  resultOf,
} from "../testing/fakes.js";
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
  budget: { max_gate_fix_cycles: 2, max_review_cycles: 1, max_cost_usd: 1, timeout_minutes: 15 },
};

const PLAN: PlannerOutput = FAKE_PLAN;

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
  const files = {
    ...OPENSPEC_SKELETON,
    ".factory/config.yaml": FAKE_PROJECT_CONFIG_YAML,
    ...extraFiles,
  };
  for (const [rel, content] of Object.entries(files)) {
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
    models: { planner: "p-model", developer: "d-model", reviewer: "r-model" },
    roles: {
      planner: { runtime: "claude-code", model: "p-model", keyEnv: [] },
      developer: { runtime: "claude-code", model: "d-model", keyEnv: [] },
      reviewer: { runtime: "claude-code", model: "r-model", keyEnv: [] },
    },
    secretEnv: [],
    reviewEval: { reviewers: [{ runtime: "claude-code", model: "r-model", keyEnv: [] }] },
    stepTimeoutsMinutes: { planner: 1, developer: 1, reviewer: 1, check: 1 },
    maxDiffCharsForReview: 100_000,
    evalCostCapUsd: 10,
    github: { tokenEnv: "FACTORY_GITHUB_TOKEN", pollIntervalSeconds: 60 },
  };
}

async function run(
  script: Script,
  opts: {
    task?: TaskSpec;
    exec?: SandboxExec;
    repo?: TargetRepo;
    store?: Store;
    runtime?: AgentRuntime;
  } = {},
) {
  const runtime = new FakeRuntime(script);
  const repo = opts.repo ?? (await makeRepo());
  const outcome = await runTask(opts.task ?? TASK, {
    config: config(),
    runtime: opts.runtime ?? runtime,
    runsDir: path.join(tmp, "runs"),
    project: FAKE_PROJECT,
    ensureRepo: () => Promise.resolve(repo),
    makeSandboxExec: () => Promise.resolve(opts.exec ?? fakeExec),
    // These tests exercise the development loop; spec approval is tested in spec.test.ts.
    specApprovalMode: "auto",
    ...(opts.store ? { store: opts.store } : {}),
  });
  return { ...resultOf(outcome), runtime, repo };
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
    expect(report.changedFiles.filter((f) => !f.startsWith("openspec/"))).toEqual([
      "src/feature.ts",
    ]);
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

  it("reads conventions and project rules as committed, never from a working tree", async () => {
    const repo = await makeRepo();
    // Uncommitted edits in the main clone must not count either.
    await writeFile(path.join(repo.dir, "CLAUDE.md"), "IGNORE ME: uncommitted rule\n");
    await writeFile(
      path.join(repo.dir, ".factory", "config.yaml"),
      FAKE_PROJECT_CONFIG_YAML.replace("npm test", "npm run sneaky"),
    );
    let devCalls = 0;
    const { report, runtime } = await run(
      {
        planner: planner(),
        developer: async (input) => {
          devCalls++;
          await writeFile(path.join(input.cwd, "src", "feature.ts"), "export const feature = 1;\n");
          // First attempt also rewrites the conventions; the rework restores them.
          await writeFile(
            path.join(input.cwd, "CLAUDE.md"),
            devCalls === 1
              ? "Evil rule: anything goes\n"
              : "# Target conventions\nUse the clock.\n",
          );
          return {};
        },
        reviewer: reviewer(APPROVE),
      },
      { repo },
    );
    expect(report.status).toBe("success");
    for (const call of runtime.calls) {
      expect(call.systemPrompt).toContain("Use the clock.");
      expect(call.systemPrompt).not.toContain("IGNORE ME");
      expect(call.systemPrompt).not.toContain("Evil rule");
    }
    const gates = report.steps.flatMap((st) => (st.kind === "gate" ? [st.result] : []));
    expect(gates[0]?.policyViolations).toEqual([
      "`CLAUDE.md` is a protected path of this project and may not be changed; revert it",
    ]);
    expect(gates[1]?.passed).toBe(true);
    expect(report.gate?.checks.map((c) => c.command.join(" "))).toEqual([
      "npm run typecheck",
      "npm test",
    ]);
    expect(report.projectId).toBe("t");
  });

  it("fills a task's missing scope and budget from the project's defaults", async () => {
    const bare = {
      id: TASK.id,
      title: TASK.title,
      request: TASK.request,
      acceptance_criteria: TASK.acceptance_criteria,
    };
    const { report } = await run(
      {
        planner: planner(),
        developer: writeFeature(["export const feature = 1;\n"]),
        reviewer: reviewer(APPROVE),
      },
      { task: bare as TaskSpec },
    );
    expect(report.status).toBe("success");
    expect(report.task.scope.allowed_paths).toEqual(["src/**", "tests/**"]);
    expect(report.task.budget).toEqual({
      max_gate_fix_cycles: 2,
      max_review_cycles: 1,
      max_cost_usd: 1,
      timeout_minutes: 15,
    });
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
    expect(fixPrompt).toContain("Rework: quality gate failed (gate fix cycle 1 of 2)");
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
    // max_review_cycles: 1 — one rework after request_changes, then the run stops.
    expect(report.fixCycles).toBe(1);
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
      {
        task: { ...TASK, budget: { ...TASK.budget, max_gate_fix_cycles: 0, max_review_cycles: 0 } },
      },
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
      {
        task: { ...TASK, budget: { ...TASK.budget, max_gate_fix_cycles: 0, max_review_cycles: 0 } },
      },
    );
    expect(report.status).toBe("gate_failed");
    expect(report.gate?.scope.violations).toEqual(["package.json"]);
    expect(runtime.rolesCalled()).not.toContain("reviewer");
  });

  it("fails the gate when the developer changes nothing", async () => {
    const { report } = await run(
      { planner: planner(), developer: () => Promise.resolve({}) },
      {
        task: { ...TASK, budget: { ...TASK.budget, max_gate_fix_cycles: 0, max_review_cycles: 0 } },
      },
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

  it("retries an invalid reviewer answer once and continues when the retry is valid", async () => {
    const { report, runtime } = await run({
      planner: planner(),
      developer: writeFeature(["a\n"]),
      reviewer: (_input, n) =>
        Promise.resolve(n === 0 ? { structured: { verdict: "maybe" } } : { structured: APPROVE }),
    });
    expect(report.status).toBe("success");
    expect(runtime.rolesCalled().filter((r) => r === "reviewer")).toHaveLength(2);
    expect(runtime.calls.filter((c) => c.role === "reviewer")[1]?.prompt).toContain(
      "Your previous answer could not be used",
    );
  });

  it("a second invalid reviewer answer is a step error", async () => {
    const { report, runtime } = await run({
      planner: planner(),
      developer: writeFeature(["a\n"]),
      reviewer: () =>
        Promise.resolve({ ok: false, error: { kind: "parse", message: "no JSON object found" } }),
    });
    expect(report.status).toBe("error");
    expect(runtime.rolesCalled().filter((r) => r === "reviewer")).toHaveLength(2);
  });

  it("serves each role with its configured runtime", async () => {
    const reviewerRuntime = new FakeRuntime({ reviewer: reviewer(APPROVE) });
    Object.defineProperty(reviewerRuntime, "name", { value: "opencode" });
    const main = new FakeRuntime({ planner: planner(), developer: writeFeature(["a\n"]) });
    const repo = await makeRepo();
    const outcome = await runTask(TASK, {
      config: config(),
      runtime: main,
      runtimes: { reviewer: reviewerRuntime },
      runsDir: path.join(tmp, "runs"),
      project: FAKE_PROJECT,
      ensureRepo: () => Promise.resolve(repo),
      makeSandboxExec: () => Promise.resolve(fakeExec),
      specApprovalMode: "auto",
    });
    const { report } = resultOf(outcome);
    expect(report.status).toBe("success");
    expect(main.rolesCalled()).toEqual(["planner", "developer"]);
    expect(reviewerRuntime.rolesCalled()).toEqual(["reviewer"]);
    expect(report.runtime).toBe("fake+opencode");
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
        // A successful run waits for a human merge decision.
        status: "awaiting_merge_approval",
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
      const events = store.listEvents(report.runId);
      const statuses = events.filter((e) => e.kind === "status").map((e) => e.payload ?? "");
      expect(statuses.some((p) => p.includes('"status":"success"'))).toBe(true);
      expect(statuses.at(-1)).toContain("awaiting_merge_approval");
      // Every state change is journaled as a graph transition, in order.
      expect(
        events.filter((e) => e.kind === "transition").map((e) => `${e.node}→${e.next}`),
      ).toEqual([
        "__start__→prepare",
        "prepare→plan",
        "plan→spec_draft",
        "spec_draft→spec_approval",
        "spec_approval→develop",
        "develop→gate",
        "gate→develop",
        "develop→gate",
        "gate→review",
        "review→report",
        "report→merge_approval",
      ]);
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

describe("cycle budgets (gate fix and review are counted and capped separately)", () => {
  let dbN = 0;
  /** Runs with a fresh database; returns the report, the `runs` row and every agent call. */
  async function runCounted(
    script: Script,
    budget: Partial<TaskBudget> = {},
    wrap?: (scripted: FakeRuntime) => AgentRuntime,
  ) {
    const db = openDb(path.join(tmp, `cycles-${++dbN}.sqlite`));
    const store = new Store(db);
    try {
      const scripted = new FakeRuntime(script);
      const task = { ...TASK, budget: { ...TASK.budget, ...budget } };
      const { report } = await run(script, {
        task,
        store,
        runtime: wrap ? wrap(scripted) : scripted,
      });
      return { report, row: store.requireRun(report.runId), calls: scripted.calls };
    } finally {
      db.close();
    }
  }
  const devPrompts = (calls: AgentRunInput[]) =>
    calls.filter((c) => c.role === "developer").map((c) => c.prompt);
  const roles = (calls: AgentRunInput[], role: string) => calls.filter((c) => c.role === role);

  it.each([1, 2])(
    "1. reviewer always requests changes → exactly max_review_cycles=%i reworks, then review_rejected; gate budget untouched",
    async (maxReview) => {
      const { report, row, calls } = await runCounted(
        {
          planner: planner(),
          developer: writeFeature(["v1\n", "v2\n", "v3\n"]),
          reviewer: reviewer(REJECT),
        },
        { max_review_cycles: maxReview },
      );
      expect(report.status).toBe("review_rejected");
      expect(roles(calls, "developer")).toHaveLength(1 + maxReview);
      expect(roles(calls, "reviewer")).toHaveLength(1 + maxReview);
      expect(row).toMatchObject({
        status: "review_rejected",
        review_cycles: maxReview,
        gate_fix_cycles: 0,
        fix_cycles: maxReview,
      });
      expect(devPrompts(calls)[1]).toContain(
        `Rework: reviewer requested changes (review cycle 1 of ${maxReview})`,
      );
    },
  );

  it("2. gate always fails → exactly max_gate_fix_cycles reworks, then gate_failed; no review", async () => {
    const { report, row, calls } = await runCounted({
      planner: planner(),
      developer: writeFeature(["BROKEN 1\n", "BROKEN 2\n", "BROKEN 3\n", "BROKEN 4\n"]),
    });
    expect(report.status).toBe("gate_failed");
    expect(roles(calls, "developer")).toHaveLength(1 + TASK.budget.max_gate_fix_cycles);
    expect(roles(calls, "reviewer")).toHaveLength(0);
    expect(row).toMatchObject({ gate_fix_cycles: 2, review_cycles: 0 });
    expect(devPrompts(calls)[2]).toContain("Rework: quality gate failed (gate fix cycle 2 of 2)");
    expect(devPrompts(calls)[2]).toContain("expected 1 got 2");
  });

  it("3. a gate failure after a review rework spends the gate budget, not the review budget", async () => {
    const { report, row, calls } = await runCounted({
      planner: planner(),
      // v1 passes the gate; the review rework breaks it; the gate fix repairs it.
      developer: writeFeature(["v1\n", "BROKEN\n", "v3\n"]),
      reviewer: reviewer(REJECT, APPROVE),
    });
    expect(report.status).toBe("success");
    expect(row).toMatchObject({ review_cycles: 1, gate_fix_cycles: 1, fix_cycles: 2 });
    const prompts = devPrompts(calls);
    expect(prompts[1]).toContain("Rework: reviewer requested changes (review cycle 1 of 1)");
    expect(prompts[2]).toContain("Rework: quality gate failed (gate fix cycle 1 of 2)");
    // With max_review_cycles = 1 a second review rework would be impossible: the review after
    // the gate fix was the second review call, and it decided the run.
    expect(roles(calls, "reviewer")).toHaveLength(2);
    // The report carries both counters and the reason of every rework.
    expect(report).toMatchObject({
      fixCycles: 2,
      gateFixCycles: 1,
      reviewCycles: 1,
      specRevisions: 0,
      firstPass: null,
      reworks: [
        { cycle: 1, reason: "review_feedback", ofKind: 1 },
        { cycle: 2, reason: "gate_failure", ofKind: 1 },
      ],
    });
  });

  it("the eval's first-pass decision is written into report.json and report.md", async () => {
    const { report, reportJsonPath, reportMdPath } = await run({
      planner: planner(),
      developer: writeFeature(["v1\n"]),
      reviewer: reviewer(APPROVE),
    });
    const md = await readFile(reportMdPath, "utf8");
    expect(md).toContain("- **First pass:** not decided");
    expect(md).toContain(
      "- **Fix cycles:** 0 of 2 after the gate, 0 of 1 after review (0 in total)",
    );
    await writeFirstPass({ reportJsonPath, reportMdPath }, true);
    const updated = JSON.parse(await readFile(reportJsonPath, "utf8")) as typeof report;
    expect(updated).toMatchObject({ runId: report.runId, firstPass: true, gateFixCycles: 0 });
    expect(await readFile(reportMdPath, "utf8")).toContain("- **First pass:** yes");
  });

  it("5. limits 0 and 0 → any failure is final at once", async () => {
    const zero = { max_gate_fix_cycles: 0, max_review_cycles: 0 };
    const gate = await runCounted(
      { planner: planner(), developer: writeFeature(["BROKEN\n"]) },
      zero,
    );
    expect(gate.report.status).toBe("gate_failed");
    expect(roles(gate.calls, "developer")).toHaveLength(1);
    expect(gate.row).toMatchObject({ gate_fix_cycles: 0, review_cycles: 0 });

    const review = await runCounted(
      { planner: planner(), developer: writeFeature(["v1\n"]), reviewer: reviewer(REJECT) },
      zero,
    );
    expect(review.report.status).toBe("review_rejected");
    expect(roles(review.calls, "developer")).toHaveLength(1);
    expect(review.row).toMatchObject({ gate_fix_cycles: 0, review_cycles: 0 });
  });

  it("6. a subscription usage limit from the runtime ends the run as infra_error, not error", async () => {
    // The developer step runs the real Claude Code adapter against a fake CLI that prints the
    // result event recorded live when the session limit was hit (fake-claude.mjs usage-limit).
    const fakeCli = path.join(FACTORY_ROOT, "src", "runtimes", "__fixtures__", "fake-claude.mjs");
    const limited = new ClaudeCodeRuntime({
      bin: process.execPath,
      binArgs: [fakeCli, "usage-limit"],
      logDir: path.join(tmp, "cli-logs"),
    });
    const { report, row } = await runCounted({ planner: planner() }, {}, (scripted) => ({
      name: "fake",
      run: (input) => (input.role === "developer" ? limited.run(input) : scripted.run(input)),
    }));
    expect(report.status).toBe("infra_error");
    expect(report.message).toMatch(/provider unavailable in developer: .*usage_limit_reached/);
    expect(row.status).toBe("infra_error");
  });
});
