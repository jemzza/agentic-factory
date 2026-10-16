// Test doubles shared by unit tests and child-process crash fixtures. Never used in production.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig } from "../config/load-config.js";
import { git } from "../git/git.js";
import type { TargetRepo } from "../git/target-repo.js";
import type { SandboxExec } from "../quality/gate.js";
import type { AgentRunInput, AgentRunResult, AgentRuntime } from "../runtimes/types.js";
import type { PlannerOutput, ReviewVerdict } from "../schemas/agents.js";
import type { SpecChange } from "../schemas/spec.js";
import type { TaskSpec } from "../schemas/task.js";
import type { RunOutcome, RunTaskResult } from "../pipeline/run-task.js";

export const FAKE_TASK: TaskSpec = {
  id: "add-feature",
  title: "Add feature",
  request: "Add a feature.",
  acceptance_criteria: ["feature exists", "feature is tested"],
  scope: { allowed_paths: ["src/**", "tests/**"] },
  budget: { max_gate_fix_cycles: 2, max_review_cycles: 1, max_cost_usd: 1, timeout_minutes: 15 },
};

export const FAKE_SPEC: SpecChange = {
  why: "Clients need the feature, and its behavior must be specified before implementation.",
  what_changes: ["Add the feature module"],
  capabilities: [
    {
      path: "feature-flags",
      kind: "new",
      purpose: "Describes the feature module that the factory's fake tasks implement in tests.",
      requirements: [
        {
          name: "Feature exists",
          source: "acceptance:1",
          text: "The system SHALL export a feature constant from src/feature.ts.",
          scenarios: [
            { name: "Import", when: "src/feature.ts is imported", then: "feature is defined" },
          ],
        },
      ],
    },
  ],
  impact: "src/feature.ts",
  tasks: ["Create src/feature.ts", "Add a test"],
};

export const FAKE_PLAN: PlannerOutput = {
  plan: "Create src/feature.ts",
  files_to_change: ["src/feature.ts"],
  risks: [],
  questions: [],
  spec: FAKE_SPEC,
};

/** Minimal `openspec init --tools none` layout, so the real `openspec validate` can run. */
export const OPENSPEC_SKELETON: Record<string, string> = {
  "openspec/config.yaml": "schema: spec-driven\n",
  "openspec/specs/.gitkeep": "",
  "openspec/changes/archive/.gitkeep": "",
};

export const FAKE_APPROVE: ReviewVerdict = {
  verdict: "approve",
  issues: [],
  criteria_check: FAKE_TASK.acceptance_criteria.map((criterion) => ({
    criterion,
    met: true,
    evidence: "src/feature.ts",
  })),
};

export const FAKE_REJECT: ReviewVerdict = {
  verdict: "request_changes",
  issues: [{ severity: "major", file: "src/feature.ts", description: "no edge case" }],
  criteria_check: FAKE_TASK.acceptance_criteria.map((criterion, i) => ({
    criterion,
    met: i === 0,
    evidence: i === 0 ? "ok" : "missing test",
  })),
};

export type FakeScript = Partial<
  Record<
    AgentRunInput["role"],
    (input: AgentRunInput, n: number) => Promise<Partial<AgentRunResult>>
  >
>;

/** Scripted runtime: per-role handlers; records every call. */
export class FakeRuntime implements AgentRuntime {
  readonly name = "fake";
  readonly calls: AgentRunInput[] = [];
  private readonly counts = new Map<string, number>();
  constructor(private readonly script: FakeScript) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.calls.push(input);
    const n = this.counts.get(input.role) ?? 0;
    this.counts.set(input.role, n + 1);
    const handler = this.script[input.role];
    if (!handler) throw new Error(`unexpected ${input.role} call`);
    const partial = await handler(input, n);
    const logPath = input.logPath ?? path.join(input.cwd, "..", "log.jsonl");
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

export const fakePlanner =
  (plan: PlannerOutput = FAKE_PLAN) =>
  () =>
    Promise.resolve({ structured: plan, output: JSON.stringify(plan) });

export const fakeReviewer =
  (...verdicts: ReviewVerdict[]) =>
  (_: AgentRunInput, n: number) =>
    Promise.resolve({ structured: verdicts[Math.min(n, verdicts.length - 1)] });

/** Developer that APPENDS a line: a replay on top of partial changes would duplicate it. */
export const appendingDeveloper =
  (line = "export const feature = 1;\n", afterWrite?: () => void) =>
  async (input: AgentRunInput) => {
    await mkdir(path.join(input.cwd, "src"), { recursive: true });
    await appendFile(path.join(input.cwd, "src", "feature.ts"), line);
    afterWrite?.();
    return { output: "Done! All checks pass." };
  };

/** Fake sandbox: `test` fails if src/feature.ts contains BROKEN; typecheck always passes. */
export const fakeExec: SandboxExec = async (wt, command) => {
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

/** A tiny target repo with one baseline commit. */
export async function makeFakeRepo(
  dir: string,
  extraFiles: Record<string, string> = {},
): Promise<TargetRepo> {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), '{"name":"t"}\n');
  await writeFile(path.join(dir, "CLAUDE.md"), "# Target conventions\nUse the clock.\n");
  await writeFile(path.join(dir, "src", "index.ts"), "export {};\n");
  for (const [rel, content] of Object.entries({ ...OPENSPEC_SKELETON, ...extraFiles })) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "baseline"]);
  await git(dir, ["tag", "factory-baseline"]);
  return { dir, baseCommit: (await git(dir, ["rev-parse", "HEAD"])).trim() };
}

export function fakeConfig(workdir: string): ResolvedConfig {
  return {
    workdir,
    workdirAbs: workdir,
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
  };
}

/**
 * The report of a run that is done with its work: either finished, or (after success)
 * waiting at the merge gate with its report already written.
 */
export function resultOf(outcome: RunOutcome): RunTaskResult {
  if (outcome.kind === "finished") return outcome;
  if (outcome.result) return outcome.result;
  throw new Error(`run paused at ${outcome.gate} approval without a report`);
}
