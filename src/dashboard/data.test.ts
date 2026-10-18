import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvalRow, RunRow, Store } from "../store/store.js";
import { comparable, readEvalSummary, readReport, type DashboardSource } from "./data.js";

let tmp: string;
let src: DashboardSource;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-dashboard-data-"));
  await writeFile(path.join(tmp, "report.json"), "{}");
  src = { store: {} as Store, runsRoot: path.join(tmp, "runs"), githubRepos: {} };
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("dashboard files", () => {
  it("never reads outside the runs directory", async () => {
    const run = { id: "r", report_path: path.join(tmp, "report.md") } as RunRow;
    expect(await readReport(src, run)).toEqual({
      problem: expect.stringContaining("outside the runs directory") as unknown,
    });
    const e = { summary_path: "/etc/summary.md" } as EvalRow;
    expect(await readEvalSummary(src, e)).toMatchObject({ kind: "missing" });
  });

  it("compares evals only on the same baseline and project", () => {
    const e = (baseline_commit: string, project_id = "t") =>
      ({ baseline_commit, project_id }) as EvalRow;
    expect(comparable(e("a"), e("a"))).toEqual({ ok: true });
    expect(comparable(e("a"), e("b"))).toMatchObject({ ok: false });
    expect(comparable(e("a"), e("a", "u"))).toMatchObject({ ok: false });
  });
});
