import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlannerOutput } from "../schemas/agents.js";
import type { SpecChange } from "../schemas/spec.js";
import { changeDir } from "../spec/openspec.js";
import { openDb } from "../store/db.js";
import { Store } from "../store/store.js";
import {
  appendingDeveloper,
  FAKE_APPROVE,
  FAKE_PLAN,
  FAKE_SPEC,
  FAKE_TASK,
  fakeConfig,
  fakeExec,
  fakeReviewer,
  FakeRuntime,
  makeFakeRepo,
  resultOf,
  type FakeScript,
} from "../testing/fakes.js";
import { resumeRun, runTask, type RunOutcome, type RunTaskDeps } from "./run-task.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-spec-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Passes our Zod schema but fails `openspec validate --strict` (duplicate requirement). */
function invalidSpec(): SpecChange {
  const cap = FAKE_SPEC.capabilities[0];
  const req = cap?.requirements[0];
  if (!cap || !req) throw new Error("fixture");
  return { ...FAKE_SPEC, capabilities: [{ ...cap, requirements: [req, req] }] };
}

let n = 0;
async function setup(script: FakeScript, specApprovalMode: "manual" | "auto" = "manual") {
  const base = path.join(tmp, `case-${++n}`);
  const repo = await makeFakeRepo(path.join(base, "repo"));
  const db = openDb(path.join(base, "factory.db"));
  const store = new Store(db);
  const runtime = new FakeRuntime(script);
  const deps: RunTaskDeps = {
    config: fakeConfig(path.join(base, "work")),
    runtime,
    runsDir: path.join(base, "runs"),
    store,
    ensureRepo: () => Promise.resolve(repo),
    makeSandboxExec: () => Promise.resolve(fakeExec),
    specApprovalMode,
  };
  return { deps, store, runtime, db };
}

/** What the CLI does on approve/reject: record the decision, then resume with it. */
async function decide(
  deps: RunTaskDeps,
  store: Store,
  runId: string,
  decision: "approve" | "reject",
  comment?: string,
): Promise<RunOutcome> {
  store.recordApproval({
    runId,
    gate: "spec",
    decision,
    actor: "tester",
    comment: comment ?? null,
  });
  const res = await resumeRun(runId, deps, {
    answer: { decision, actor: "tester", ...(comment ? { comment } : {}) },
  });
  if (res.kind !== "resumed") throw new Error(`not resumed: ${res.kind}`);
  return res.outcome;
}

const plannerWith =
  (...specs: (SpecChange | null)[]) =>
  (_: unknown, i: number) => {
    const plan: PlannerOutput = {
      ...FAKE_PLAN,
      spec: specs[Math.min(i, specs.length - 1)] ?? FAKE_SPEC,
    };
    return Promise.resolve({ structured: plan });
  };
const standardScript = (): FakeScript => ({
  planner: plannerWith(FAKE_SPEC),
  developer: appendingDeveloper(),
  reviewer: fakeReviewer(FAKE_APPROVE),
});

describe("spec drafting and approval", () => {
  it("stops at spec approval with a valid OpenSpec change committed; approve continues to success", async () => {
    const { deps, store, runtime, db } = await setup(standardScript());
    try {
      const first = await runTask(FAKE_TASK, deps);
      if (first.kind !== "awaiting") throw new Error("expected to wait for approval");
      expect(first.gate).toBe("spec");
      expect(runtime.rolesCalled()).toEqual(["planner"]);
      const row = store.requireRun(first.runId);
      expect(row).toMatchObject({
        status: "awaiting_spec_approval",
        spec_approval: "manual",
        locked_by: null,
      });
      expect(await readFile(first.noticePath, "utf8")).toContain(
        `npm run approve -- ${first.runId} spec`,
      );
      // The spec is committed in the worktree (clean tree at the spec commit).
      const specFile = path.join(row.worktree_path ?? "", changeDir(FAKE_TASK.id), "proposal.md");
      expect(await readFile(specFile, "utf8")).toContain("## Why");

      const done = await decide(deps, store, first.runId, "approve");
      const doneResult = resultOf(done);
      expect(doneResult.report.status).toBe("success");
      // Waiting for the human is not active time.
      expect(doneResult.report.activeDurationMs).toBeLessThanOrEqual(
        doneResult.report.wallDurationMs ?? 0,
      );
      expect(store.requireRun(first.runId).wall_duration_ms).toBe(doneResult.report.wallDurationMs);
      expect(doneResult.report.spec).toMatchObject({
        approvalMode: "manual",
        valid: true,
        attempts: 1,
        rejections: [],
      });
      // Developer and reviewer get the approved spec; the reviewer sees the code diff only.
      const dev = runtime.calls.find((c) => c.role === "developer");
      const rev = runtime.calls.find((c) => c.role === "reviewer");
      expect(dev?.prompt).toContain("Approved specification (OpenSpec change)");
      expect(rev?.prompt).toContain("### Requirement: Feature exists");
      expect(rev?.prompt).not.toContain("+## Why"); // spec files are not part of the reviewed diff
      expect(store.listApprovals(first.runId).map((a) => [a.decision, a.actor])).toEqual([
        ["approve", "tester"],
      ]);
    } finally {
      db.close();
    }
  });

  it("reject sends the run back to planning with the comment; the third reject asks for clarification", async () => {
    const { deps, store, runtime, db } = await setup(standardScript());
    try {
      const first = await runTask(FAKE_TASK, deps);
      if (first.kind !== "awaiting") throw new Error("expected to wait");
      const second = await decide(deps, store, first.runId, "reject", "cover the 404 case");
      expect(second.kind).toBe("awaiting");
      const replan = runtime.calls.filter((c) => c.role === "planner")[1];
      expect(replan?.prompt).toContain("cover the 404 case");

      expect((await decide(deps, store, first.runId, "reject", "still missing")).kind).toBe(
        "awaiting",
      );
      const last = await decide(deps, store, first.runId, "reject", "give up");
      const lastResult = resultOf(last);
      expect(lastResult.report.status).toBe("needs_clarification");
      expect(lastResult.report.spec?.rejections).toEqual([
        "cover the 404 case",
        "still missing",
        "give up",
      ]);
      expect(runtime.rolesCalled().filter((r) => r === "developer")).toHaveLength(0);
      expect(store.requireRun(first.runId).status).toBe("needs_clarification");
    } finally {
      db.close();
    }
  });

  it("auto approval records approval: auto and never pauses", async () => {
    const { deps, store, db } = await setup(standardScript(), "auto");
    try {
      const out = resultOf(await runTask(FAKE_TASK, deps));
      expect(out.report.status).toBe("success");
      expect(out.report.spec?.approvalMode).toBe("auto");
      expect(store.requireRun(out.report.runId).spec_approval).toBe("auto");
      expect(store.listApprovals(out.report.runId).map((a) => a.actor)).toEqual(["auto"]);
    } finally {
      db.close();
    }
  });

  it("an invalid spec gets one fix by the planner, using the validator output", async () => {
    const script = standardScript();
    script.planner = (input, i) =>
      i === 0
        ? Promise.resolve({ structured: { ...FAKE_PLAN, spec: invalidSpec() } })
        : Promise.resolve({ structured: FAKE_SPEC }); // spec-fix call returns a bare spec
    const { deps, runtime, db } = await setup(script, "auto");
    try {
      const out = resultOf(await runTask(FAKE_TASK, deps));
      expect(out.report.status).toBe("success");
      expect(out.report.spec).toMatchObject({ valid: true, attempts: 2 });
      const fix = runtime.calls.filter((c) => c.role === "planner")[1];
      expect(fix?.prompt).toContain("Duplicate requirement in ADDED");
      expect(out.report.steps.flatMap((s) => (s.kind === "spec" ? [s.valid] : []))).toEqual([
        false,
        true,
      ]);
    } finally {
      db.close();
    }
  });

  it("a spec that stays invalid after the fix ends the run with error", async () => {
    const script = standardScript();
    script.planner = (_input, i) =>
      Promise.resolve({
        structured: i === 0 ? { ...FAKE_PLAN, spec: invalidSpec() } : invalidSpec(),
      });
    const { deps, runtime, db } = await setup(script, "auto");
    try {
      const out = resultOf(await runTask(FAKE_TASK, deps));
      expect(out.report.status).toBe("error");
      expect(out.report.message).toMatch(/OpenSpec validation failed after 2 attempt/);
      expect(runtime.rolesCalled()).toEqual(["planner", "planner"]);
    } finally {
      db.close();
    }
  });

  it("the gate fails with a policy violation when the developer edits the approved spec", async () => {
    const script = standardScript();
    script.developer = async (input) => {
      await mkdir(path.join(input.cwd, "src"), { recursive: true });
      await appendFile(path.join(input.cwd, "src", "feature.ts"), "export const feature = 1;\n");
      await appendFile(
        path.join(input.cwd, changeDir(FAKE_TASK.id), "proposal.md"),
        "\nsneaky edit\n",
      );
      return {};
    };
    const { deps, runtime, db } = await setup(script, "auto");
    try {
      const out = resultOf(
        await runTask({ ...FAKE_TASK, budget: { ...FAKE_TASK.budget, max_fix_cycles: 0 } }, deps),
      );
      expect(out.report.status).toBe("gate_failed");
      expect(out.report.gate?.policyViolations.join("\n")).toMatch(
        /approved specification file .*proposal\.md/,
      );
      expect(runtime.rolesCalled()).not.toContain("reviewer");
    } finally {
      db.close();
    }
  });

  it("plain resume of a run waiting for approval does nothing", async () => {
    const { deps, db } = await setup(standardScript());
    try {
      const first = await runTask(FAKE_TASK, deps);
      if (first.kind !== "awaiting") throw new Error("expected to wait");
      const res = await resumeRun(first.runId, deps);
      expect(res).toMatchObject({
        kind: "awaiting_human",
        run: { status: "awaiting_spec_approval" },
      });
    } finally {
      db.close();
    }
  });

  it("a requirement without source fails the schema check and gets one fix", async () => {
    const noSource = structuredClone(FAKE_SPEC) as unknown as {
      capabilities: { requirements: Record<string, unknown>[] }[];
    };
    const req = noSource.capabilities[0]?.requirements[0];
    if (!req) throw new Error("fixture");
    delete req["source"];
    const script = standardScript();
    script.planner = (_input, i) =>
      Promise.resolve({ structured: i === 0 ? { ...FAKE_PLAN, spec: noSource } : FAKE_SPEC });
    const { deps, runtime, db } = await setup(script, "auto");
    try {
      const out = resultOf(await runTask(FAKE_TASK, deps));
      expect(out.report.status).toBe("success");
      expect(out.report.spec).toMatchObject({ valid: true, attempts: 2 });
      const fix = runtime.calls.filter((c) => c.role === "planner")[1];
      expect(fix?.prompt).toMatch(/capabilities\.0\.requirements\.0\.source/);
      const first = out.report.steps.find((s) => s.kind === "spec");
      expect(first?.kind === "spec" && first.valid).toBe(false);
    } finally {
      db.close();
    }
  });

  it("a source that names a non-existent acceptance criterion is rejected, and stays an error if not fixed", async () => {
    const bad = structuredClone(FAKE_SPEC);
    const req = bad.capabilities[0]?.requirements[0];
    if (!req) throw new Error("fixture");
    req.source = "acceptance:9";
    const script = standardScript();
    script.planner = (_input, i) =>
      Promise.resolve({ structured: i === 0 ? { ...FAKE_PLAN, spec: bad } : bad });
    const { deps, db } = await setup(script, "auto");
    try {
      const out = resultOf(await runTask(FAKE_TASK, deps));
      expect(out.report.status).toBe("error");
      expect(out.report.message).toMatch(
        /acceptance:9" does not exist: the task has 2 acceptance criteria/,
      );
    } finally {
      db.close();
    }
  });

  it("the approval notice lists existing-behavior requirements separately and traces the rest", async () => {
    const spec = structuredClone(FAKE_SPEC);
    const cap = spec.capabilities[0];
    if (!cap) throw new Error("fixture");
    cap.requirements.push({
      name: "Keep the error format",
      source: "existing_behavior",
      text: "Errors MUST keep the { error: { code, message } } format.",
      scenarios: [{ name: "Error", when: "any error occurs", then: "the body has error.code" }],
    });
    const { deps, db } = await setup({ ...standardScript(), planner: plannerWith(spec) });
    try {
      const out = await runTask(FAKE_TASK, deps);
      if (out.kind !== "awaiting") throw new Error("expected to wait");
      const notice = await readFile(out.noticePath, "utf8");
      const existing = notice.slice(
        notice.indexOf("Requirements based on existing behavior"),
        notice.indexOf("Where each requirement"),
      );
      expect(existing).toContain("Keep the error format");
      expect(existing).not.toContain("Feature exists");
      expect(notice).toContain(
        "**Feature exists** (`feature-flags`) ← acceptance criterion 1: “feature exists”",
      );
    } finally {
      db.close();
    }
  });
});
