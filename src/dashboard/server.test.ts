import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aggregate, stat } from "../eval/repeat.js";
import { runTask } from "../pipeline/run-task.js";
import { openDb } from "../store/db.js";
import { createRedactor } from "../store/redact.js";
import { Store } from "../store/store.js";
import {
  appendingDeveloper,
  FAKE_APPROVE,
  FAKE_PLAN,
  FAKE_PROJECT,
  FAKE_TASK,
  fakeConfig,
  fakeExec,
  fakeReviewer,
  FakeRuntime,
  makeFakeRepo,
  resultOf,
} from "../testing/fakes.js";
import { buildDashboard, DASHBOARD_HOST } from "./server.js";

const PORT = 4317;
const HOST = `${DASHBOARD_HOST}:${String(PORT)}`;
const SECRET = "configured-secret-value-123456";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

let tmp: string;
let runsRoot: string;
let store: Store;
let runId: string;
let app: ReturnType<typeof buildDashboard>;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-dashboard-"));
  runsRoot = path.join(tmp, "runs");
  const writer = new Store(openDb(path.join(tmp, "factory.db")));
  const repo = await makeFakeRepo(path.join(tmp, "repo"));
  const finding = `<script>alert(1)</script> leaked ${TOKEN} and ${SECRET}`;
  const outcome = await runTask(FAKE_TASK, {
    config: fakeConfig(path.join(tmp, "work")),
    runtime: new FakeRuntime({
      planner: () => Promise.resolve({ structured: FAKE_PLAN }),
      developer: appendingDeveloper('export const x = "<img src=x onerror=alert(2)>";\n'),
      reviewer: fakeReviewer({
        ...FAKE_APPROVE,
        issues: [{ severity: "minor", file: "src/feature.ts", description: finding }],
      }),
    }),
    runsDir: runsRoot,
    store: writer,
    project: FAKE_PROJECT,
    ensureRepo: () => Promise.resolve(repo),
    makeSandboxExec: () => Promise.resolve(fakeExec),
    specApprovalMode: "auto",
  });
  runId = resultOf(outcome).report.runId;
  writer.updateRun(runId, { issueNumber: 7, prNumber: 9 });
  writer.recordApproval({
    runId,
    gate: "spec",
    decision: "reject",
    actor: "owner",
    channel: "github",
    comment: "Please add the error path.",
  });

  // Evals: two on one baseline, one on another; suite summaries next to summary.md.
  const evalRow = async (id: string, baseline: string, verified: number) => {
    writer.createEval({
      id,
      repeatCount: 1,
      baselineCommit: baseline,
      costCapUsd: 10,
      projectId: "t",
    });
    const dir = path.join(runsRoot, id);
    await mkdir(dir, { recursive: true });
    const s = aggregate(id, [], {
      repeatsPlanned: 1,
      roles: { developer: "claude-code:opus" },
      baselineCommit: baseline,
      costCapUsd: 10,
      costCapReached: false,
    });
    s.metrics.verifiedRate = stat([verified]);
    s.tasks = { "complete-task": [verified === 1 ? "verified" : "false_success✗"] };
    await writeFile(path.join(dir, "summary.json"), JSON.stringify(s));
    await writeFile(path.join(dir, "summary.md"), "# summary");
    writer.finishEval(id, {
      status: "completed",
      repeatCount: 1,
      costUsd: 5,
      summaryPath: path.join(dir, "summary.md"),
    });
  };
  await evalRow("eval-20261001-000000", "a".repeat(40), 0.5);
  await evalRow("eval-20261002-000000", "a".repeat(40), 1);
  await evalRow("eval-20261003-000000", "b".repeat(40), 1);
  writer.db.close();

  // The dashboard's own connection, as the CLI opens it.
  const db = openDb(path.join(tmp, "factory.db"));
  db.pragma("query_only = ON");
  store = new Store(db);
  app = buildDashboard(
    { store, runsRoot, githubRepos: { t: "owner/taskflow-demo" } },
    { redact: createRedactor([SECRET]), port: PORT },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  store.db.close();
  await rm(tmp, { recursive: true, force: true });
});

const get = (url: string, host = HOST) => app.inject({ method: "GET", url, headers: { host } });

describe("dashboard is read-only", () => {
  it("has no POST, PUT, PATCH or DELETE routes", () => {
    const routes = app.printRoutes({ commonPrefix: false });
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(routes).not.toContain(m);
    expect(routes).toContain("GET");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("%s is answered 404", async (method) => {
    for (const url of ["/", "/runs/x", "/evals"]) {
      const res = await app.inject({ method, url, headers: { host: HOST } });
      expect(res.statusCode).toBe(404);
    }
  });

  it("its database connection refuses writes", () => {
    expect(() => store.updateRun(runId, { statusMessage: "x" })).toThrow(/readonly|query_only/i);
  });

  it("refuses requests for another Host (no DNS rebinding)", async () => {
    expect((await get("/", "evil.example:4317")).statusCode).toBe(403);
    expect((await get("/", `localhost:${String(PORT)}`)).statusCode).toBe(200);
  });

  it("sends a CSP without scripts", async () => {
    const res = await get("/");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.body).not.toMatch(/<script/i);
  });
});

describe("pages", () => {
  it("lists runs with project and status filters and GitHub links", async () => {
    const all = await get("/");
    expect(all.body).toContain(`/runs/${runId}`);
    expect(all.body).toContain('href="https://github.com/owner/taskflow-demo/issues/7"');
    expect(all.body).toContain('href="https://github.com/owner/taskflow-demo/pull/9"');
    expect((await get("/?project=t&status=awaiting_merge_approval")).body).toContain(runId);
    expect((await get("/?project=other")).body).not.toContain(`/runs/${runId}`);
    expect((await get("/?status=merged")).body).not.toContain(`/runs/${runId}`);
    expect((await get("/?status=<bogus>")).statusCode).toBe(200); // invalid filter = none
  });

  it("shows a whole run: spec, diff, gate, review, events, approvals with their channel", async () => {
    const res = await get(`/runs/${runId}`);
    expect(res.statusCode).toBe(200);
    const b = res.body;
    for (const section of ["Approvals", "Spec", "Diff", "Gate", "Review", "Steps", "Events"])
      expect(b).toContain(`<h2>${section}</h2>`);
    expect(b).toMatch(/<td>reject<\/td>\s*<td>owner<\/td>\s*<td>github<\/td>/);
    expect(b).toMatch(/<td>approve<\/td>\s*<td>auto<\/td>\s*<td>auto<\/td>/);
    expect(b).toContain("src/feature.ts");
    expect(b).toMatch(/Gate:\s*<span class="ok">passed<\/span>/);
  });

  it("escapes agent output and masks secrets", async () => {
    const b = (await get(`/runs/${runId}`)).body;
    expect(b).not.toContain("<script>alert(1)");
    expect(b).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(b).not.toContain("<img src=x");
    expect(b).not.toContain(TOKEN);
    expect(b).not.toContain(SECRET);
    expect(b).toContain("***");
  });

  it("shows an eval with its metrics and runs", async () => {
    const b = (await get("/evals/eval-20261002-000000")).body;
    expect(b).toContain("Verified rate");
    expect(b).toContain("100.0%");
    expect((await get("/evals")).body).toContain("/evals/eval-20261003-000000");
  });

  it("compares two evals only on the same baseline", async () => {
    const same = (await get("/evals/compare?a=eval-20261001-000000&b=eval-20261002-000000")).body;
    expect(same).toContain("50.0%");
    expect(same).toContain("+50.0%");
    const other = (await get("/evals/compare?a=eval-20261001-000000&b=eval-20261003-000000")).body;
    expect(other).toContain("Not comparable: different baselines");
    expect(other).not.toContain("Δ (B − A)");
  });

  it("answers 404 for unknown runs, evals and pages", async () => {
    expect((await get("/runs/nope")).statusCode).toBe(404);
    expect((await get("/runs/..%2F..%2Fetc")).statusCode).toBe(404);
    expect((await get("/evals/nope")).statusCode).toBe(404);
    expect((await get("/admin")).statusCode).toBe(404);
  });
});
