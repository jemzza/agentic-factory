import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../git/git.js";
import type { AgentRunInput } from "../runtimes/types.js";
import type { ProjectEntry } from "../schemas/project.js";
import { openDb } from "../store/db.js";
import { Store } from "../store/store.js";
import {
  FAKE_APPROVE,
  FAKE_PLAN,
  FakeRuntime,
  fakeConfig,
  fakeExec,
  fakeReviewer,
  makeFakeRepo,
} from "../testing/fakes.js";
import { GhCli } from "./gh-cli.js";
import { ghRemote } from "./remote.js";
import { Watcher } from "./watch.js";

/*
 * factory:watch --concurrency 4 with two projects and ten issues, end to end on a fake GitHub
 * (fake gh, bare git repositories as remotes, fake agents): every run is planned, approved,
 * implemented, merged and pushed, with no git or SQLite conflict.
 */

const FAKE_GH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "fake-gh.mjs",
);
const TOKEN = "ghp_test_concurrency";
let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "factory-watch-conc-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const body = (n: number) =>
  `### Request\n\nAdd feature ${n}.\n\n### Acceptance criteria\n\n- feature exists\n- feature is tested\n\n### Scope (optional)\n\n_No response_\n\n### Budget (optional)\n\n_No response_`;

describe("factory:watch --concurrency 4, two projects", () => {
  it("drives ten issues to merged pull requests without git or SQLite conflicts", async () => {
    const projects: ProjectEntry[] = [];
    const origins: Record<string, string> = {};
    const stateFiles: Record<string, string> = {};
    for (const id of ["alpha", "beta"]) {
      const seed = await makeFakeRepo(path.join(root, id, "seed"));
      const origin = path.join(root, id, "origin.git");
      await git(root, ["clone", "-q", "--bare", seed.dir, origin]);
      origins[id] = origin;
      projects.push({
        id,
        source: { kind: "git", url: origin, ref: "main" },
        github: { repo: `owner/${id}` },
        allowed_users: ["owner"],
      });
    }
    // One fake GitHub serves both repositories; every entry carries its `repo`.
    const stateFile = path.join(root, "gh.json");
    let clock = Date.parse("2026-10-20T10:00:00Z");
    const iso = () => new Date((clock += 1000)).toISOString();
    const issues = [];
    for (let i = 1; i <= 10; i++) {
      const project = i <= 5 ? "alpha" : "beta";
      const t = iso();
      issues.push({
        id: 100 + i,
        // Each repository numbers its own issues 1..5.
        number: i <= 5 ? i : i - 5,
        title: `Feature ${i}`,
        body: body(i),
        state: "open",
        user: { login: "owner", type: "User" },
        labels: ["factory"],
        created_at: t,
        updated_at: t,
        repo: `owner/${project}`,
      });
    }
    await writeFile(
      stateFile,
      JSON.stringify({
        clock,
        nextId: 5000,
        tokenOwner: "owner",
        expectedToken: TOKEN,
        issues,
        comments: [],
        pulls: [],
        requests: [],
      }),
    );
    stateFiles["all"] = stateFile;

    let inDeveloper = 0;
    let maxDeveloper = 0;
    const runtime = new FakeRuntime({
      planner: () => Promise.resolve({ structured: FAKE_PLAN }),
      developer: async (input: AgentRunInput) => {
        inDeveloper++;
        maxDeveloper = Math.max(maxDeveloper, inDeveloper);
        // Slower than dispatching the next approval (each fake gh call is a process).
        await new Promise((r) => setTimeout(r, 400));
        // Each task its own file, so the five merges of a project do not conflict.
        const file = path.join(
          input.cwd,
          "src",
          `${path.basename(input.cwd).split("-20")[0] ?? "x"}.ts`,
        );
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "export const feature = 1;\n");
        inDeveloper--;
        return {};
      },
      reviewer: fakeReviewer(FAKE_APPROVE),
    });
    const store = new Store(openDb(path.join(root, "factory.db")), { secrets: [TOKEN] });
    const api = new GhCli({
      token: TOKEN,
      bin: process.execPath,
      binArgs: [FAKE_GH],
      extraEnv: { FAKE_GH_STATE: stateFile },
    });
    const watcher = new Watcher({
      api,
      remote: ghRemote({ token: null }),
      store,
      projects,
      concurrency: 4,
      runDeps: () => ({
        config: fakeConfig(path.join(root, "work")),
        runtime,
        runsDir: path.join(root, "runs"),
        store,
        makeSandboxExec: () => Promise.resolve(fakeExec),
      }),
    });
    const read = async () =>
      JSON.parse(await readFile(stateFile, "utf8")) as {
        clock: number;
        issues: { number: number; state: string; repo: string }[];
        comments: { body: string; issue_url: string }[];
        pulls: { number: number; head: string; repo: string }[];
      };
    const comment = async (repo: string, n: number, text: string) => {
      const s = (await read()) as unknown as { clock: number; nextId: number; comments: object[] };
      const t = new Date((s.clock += 1000)).toISOString();
      s.comments.push({
        id: s.nextId++,
        body: text,
        user: { login: "owner", type: "User" },
        created_at: t,
        updated_at: t,
        issue_url: `https://api.github.com/repos/${repo}/issues/${n}`,
        html_url: "x",
      });
      await writeFile(stateFile, JSON.stringify(s));
    };

    // Plan all ten (four at a time), approve all, then merge all.
    const first = await watcher.pollOnce();
    await watcher.drain();
    const statuses = store.db
      .prepare(
        "SELECT project_id, issue_number, status, status_message FROM runs ORDER BY project_id, issue_number",
      )
      .all();
    expect({ errors: first.errors, statuses }).toMatchObject({ errors: [] });
    for (const p of ["alpha", "beta"]) {
      expect(
        store.listGithubRuns(p, ["awaiting_spec_approval"]),
        JSON.stringify(statuses),
      ).toHaveLength(5);
    }
    for (const p of ["alpha", "beta"]) {
      for (let i = 1; i <= 5; i++) await comment(`owner/${p}`, i, "/approve");
    }
    await watcher.pollOnce();
    await watcher.drain();
    expect(maxDeveloper).toBeGreaterThan(1);
    expect(maxDeveloper).toBeLessThanOrEqual(4);
    for (const p of ["alpha", "beta"]) {
      expect(store.listGithubRuns(p, ["awaiting_merge_approval"])).toHaveLength(5);
    }
    for (const pr of (await read()).pulls) await comment(pr.repo, pr.number, "/merge");
    await watcher.pollOnce();
    await watcher.drain();
    for (const p of ["alpha", "beta"]) {
      expect(store.listGithubRuns(p, ["merged"])).toHaveLength(5);
      // All five merges landed on the remote's main, one after another (per-project lock).
      const log = await git(origins[p] ?? "", ["log", "--merges", "--format=%s", "main"]);
      expect(log.trim().split("\n")).toHaveLength(5);
      expect((await git(origins[p] ?? "", ["fsck", "--no-progress"])).trim()).toBe("");
    }
    expect((await read()).issues.every((i) => i.state === "closed")).toBe(true);
    // Every run has its checkpoint chain and no step was left running.
    const steps = store.db
      .prepare("SELECT COUNT(*) n FROM steps WHERE status = 'running'")
      .get() as { n: number };
    expect(steps.n).toBe(0);
    store.db.close();
  }, 120_000);
});
