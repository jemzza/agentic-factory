import { describe, expect, it } from "vitest";
import { taskFromIssue } from "./issue-form.js";

const body = (o: { request?: string; criteria?: string; scope?: string; budget?: string } = {}) =>
  [
    "### Request",
    "",
    o.request ?? "Add archiving.",
    "",
    "### Acceptance criteria",
    "",
    o.criteria ?? "- POST /tasks/:id/archive returns 200\n- Archiving a deleted task returns 409",
    "",
    "### Scope (optional)",
    "",
    o.scope ?? "_No response_",
    "",
    "### Budget (optional)",
    "",
    o.budget ?? "_No response_",
  ].join("\n");

describe("taskFromIssue", () => {
  it("turns an issue form into a task: id from the number, title from the issue", () => {
    expect(taskFromIssue({ number: 7, title: " Archive tasks ", body: body() })).toEqual({
      ok: true,
      task: {
        id: "issue-7",
        title: "Archive tasks",
        request: "Add archiving.",
        acceptance_criteria: [
          "POST /tasks/:id/archive returns 200",
          "Archiving a deleted task returns 409",
        ],
      },
    });
  });

  it("takes optional scope and budget lines", () => {
    const r = taskFromIssue({
      number: 1,
      title: "T",
      body: body({ scope: "src/**\ntests/**", budget: "max_cost_usd: 1.5\nmax_review_cycles: 2" }),
    });
    expect(r).toMatchObject({
      ok: true,
      task: {
        scope: { allowed_paths: ["src/**", "tests/**"] },
        budget: { max_cost_usd: 1.5, max_review_cycles: 2 },
      },
    });
  });

  it("lists every problem of an invalid issue", () => {
    const r = taskFromIssue({
      number: 1,
      title: "T",
      body: body({ request: "_No response_", criteria: "", budget: "max_cost_usd: lots\nfoo: 1" }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      '"Request" is empty',
      '"Acceptance criteria" has no criteria (one per line)',
      'budget line "max_cost_usd: lots" is not "<max_cost_usd|timeout_minutes|max_gate_fix_cycles|max_review_cycles>: <number>"',
      'budget line "foo: 1" is not "<max_cost_usd|timeout_minutes|max_gate_fix_cycles|max_review_cycles>: <number>"',
    ]);
  });

  it("validates with the Task schema (factory caps apply)", () => {
    const r = taskFromIssue({
      number: 1,
      title: "T",
      body: body({ budget: "max_review_cycles: 5" }),
    });
    expect(r.ok).toBe(false);
  });

  it("a body without the form is invalid, not guessed", () => {
    expect(taskFromIssue({ number: 1, title: "T", body: "please add archiving" }).ok).toBe(false);
    expect(taskFromIssue({ number: 1, title: "T", body: null }).ok).toBe(false);
  });
});
