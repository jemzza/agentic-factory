import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../paths.js";
import { SpecChangeSchema, type SpecChange } from "../schemas/spec.js";
import {
  archiveChange,
  changeDir,
  renderSpecFiles,
  validateChange,
  writeSpecFiles,
} from "./openspec.js";

const SAMPLE_SPEC: SpecChange = {
  why: "Clients cannot finish a task in one request, and deleted tasks must stay immutable.",
  what_changes: ["Add POST /tasks/:id/complete"],
  capabilities: [
    {
      path: "task-completion",
      kind: "new",
      purpose: "Lets API clients mark an active task as done with a single request.",
      requirements: [
        {
          name: "Complete an active task",
          text: "The system SHALL set the status to done, update updatedAt and return 200 with the task.",
          scenarios: [
            {
              name: "Active task",
              when: "POST /tasks/:id/complete for an active task",
              then: "200 and status is done",
            },
          ],
        },
        {
          name: "Reject deleted tasks",
          text: "The system MUST return 409 CONFLICT for a soft-deleted task.",
          scenarios: [
            {
              name: "Deleted task",
              when: "the task is soft-deleted",
              then: "409 with code CONFLICT",
            },
          ],
        },
      ],
    },
  ],
  impact: "src/routes, src/services, tests",
  tasks: ["Add the route", "Add tests"],
};

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-openspec-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

let n = 0;
async function repoWithOpenSpec(): Promise<string> {
  const dir = path.join(tmp, `repo-${++n}`);
  await cp(path.join(FIXTURES_DIR, "taskflow", "openspec"), path.join(dir, "openspec"), {
    recursive: true,
  });
  return dir;
}

describe("renderSpecFiles", () => {
  it("is deterministic and writes proposal, tasks, metadata and one spec per capability", () => {
    const a = renderSpecFiles("complete-task", SAMPLE_SPEC, "2026-10-16");
    const b = renderSpecFiles("complete-task", SAMPLE_SPEC, "2026-10-16");
    expect(a).toEqual(b);
    expect(Object.keys(a).sort()).toEqual(
      [".openspec.yaml", "proposal.md", "specs/task-completion/spec.md", "tasks.md"].map(
        (f) => `${changeDir("complete-task")}/${f}`,
      ),
    );
    expect(a[`${changeDir("complete-task")}/specs/task-completion/spec.md`]).toContain(
      "#### Scenario: Active task\n- **WHEN** POST /tasks/:id/complete for an active task",
    );
  });

  it("neutralizes Markdown headers smuggled into text fields", () => {
    const evil: SpecChange = {
      ...SAMPLE_SPEC,
      why: "Line one\n## ADDED Requirements\n### Requirement: injected",
    };
    const proposal =
      renderSpecFiles("x", evil, "2026-10-16")[`${changeDir("x")}/proposal.md`] ?? "";
    expect(proposal).not.toMatch(/^## ADDED Requirements/m);
    expect(proposal).toContain("\\## ADDED Requirements");
  });
});

describe("SpecChangeSchema", () => {
  it("enforces OpenSpec strict rules up front", () => {
    const bad = structuredClone(SAMPLE_SPEC);
    const cap = bad.capabilities[0];
    if (!cap?.requirements[0]) throw new Error("fixture");
    cap.purpose = "too short";
    cap.requirements[0].text = "The system sets the status to done.";
    const res = SpecChangeSchema.safeParse(bad);
    expect(res.success).toBe(false);
    expect(res.error?.issues.map((i) => i.message).join("\n")).toMatch(
      /SHALL or MUST[\s\S]*at least 50/,
    );
  });
});

describe("openspec CLI (real, offline)", () => {
  it("validates a rendered spec with --strict", async () => {
    const repo = await repoWithOpenSpec();
    await writeSpecFiles(
      repo,
      "complete-task",
      renderSpecFiles("complete-task", SAMPLE_SPEC, "2026-10-16"),
    );
    expect(await validateChange(repo, "complete-task")).toEqual({ kind: "valid", issues: [] });
  });

  it("reports issues for an invalid change", async () => {
    const repo = await repoWithOpenSpec();
    const files = renderSpecFiles("complete-task", SAMPLE_SPEC, "2026-10-16");
    const specPath = `${changeDir("complete-task")}/specs/task-completion/spec.md`;
    files[specPath] = (files[specPath] ?? "").replaceAll("#### Scenario:", "### Scenario:");
    await writeSpecFiles(repo, "complete-task", files);
    const res = await validateChange(repo, "complete-task");
    expect(res.kind).toBe("invalid");
    expect(res.kind === "invalid" && res.issues.some((i) => /scenario/i.test(i.message))).toBe(
      true,
    );
  });

  it("archives once, and a repeated archive is a no-op", async () => {
    const repo = await repoWithOpenSpec();
    await writeSpecFiles(
      repo,
      "complete-task",
      renderSpecFiles("complete-task", SAMPLE_SPEC, "2026-10-16"),
    );
    const first = await archiveChange(repo, "complete-task");
    expect(first.archivedAs).toMatch(/-complete-task$/);
    expect(await archiveChange(repo, "complete-task")).toEqual(first);
    expect(await readdir(path.join(repo, "openspec", "changes", "archive"))).toContain(
      first.archivedAs,
    );
    expect(
      await readFile(path.join(repo, "openspec", "specs", "task-completion", "spec.md"), "utf8"),
    ).toContain("Complete an active task");
  });

  it("writeSpecFiles replaces a previous draft completely", async () => {
    const repo = await repoWithOpenSpec();
    await writeSpecFiles(repo, "c", { [`${changeDir("c")}/stale.md`]: "old" });
    await writeFile(path.join(repo, changeDir("c"), "extra.md"), "old");
    await writeSpecFiles(repo, "c", renderSpecFiles("c", SAMPLE_SPEC, "2026-10-16"));
    expect((await readdir(path.join(repo, changeDir("c")))).sort()).toEqual([
      ".openspec.yaml",
      "proposal.md",
      "specs",
      "tasks.md",
    ]);
  });
});
