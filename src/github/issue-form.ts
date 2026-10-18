import { TaskFileSchema, type TaskFile } from "../schemas/task.js";

/*
 * An issue created from `.github/ISSUE_TEMPLATE/factory-task.yml` has a body of sections
 * "### <field label>" followed by the answer; an empty optional answer is "_No response_"
 * (GitHub issue forms). The title is the task title.
 */

const SECTIONS = {
  request: "Request",
  acceptance_criteria: "Acceptance criteria",
  scope: "Scope (optional)",
  budget: "Budget (optional)",
} as const;

const NO_RESPONSE = "_No response_";

export function issueSections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (current !== null) out.set(current, lines.join("\n").trim());
  };
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const h = /^###\s+(.+?)\s*$/.exec(line);
    if (h?.[1]) {
      flush();
      current = h[1];
      lines = [];
    } else lines.push(line);
  }
  flush();
  return out;
}

const listItems = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
    .filter((l) => l !== "");

const BUDGET_KEYS = ["max_cost_usd", "timeout_minutes", "max_gate_fix_cycles", "max_review_cycles"];

export type IssueTask = { ok: true; task: TaskFile } | { ok: false; errors: string[] };

/** Turns an issue into a task file (validated with the Task schema), or lists what is wrong. */
export function taskFromIssue(issue: {
  number: number;
  title: string;
  body: string | null;
}): IssueTask {
  const s = issueSections(issue.body ?? "");
  const errors: string[] = [];
  const value = (k: keyof typeof SECTIONS) => {
    const v = s.get(SECTIONS[k]);
    return v === undefined || v === NO_RESPONSE ? "" : v;
  };
  const request = value("request");
  const criteria = listItems(value("acceptance_criteria"));
  if (!request) errors.push(`"${SECTIONS.request}" is empty`);
  if (criteria.length === 0)
    errors.push(`"${SECTIONS.acceptance_criteria}" has no criteria (one per line)`);

  const scope = listItems(value("scope"));
  const budget: Record<string, number> = {};
  for (const line of listItems(value("budget"))) {
    const m = /^([a-z_]+)\s*:\s*([0-9]+(?:\.[0-9]+)?)$/.exec(line);
    if (!m?.[1] || !m[2] || !BUDGET_KEYS.includes(m[1])) {
      errors.push(`budget line "${line}" is not "<${BUDGET_KEYS.join("|")}>: <number>"`);
    } else budget[m[1]] = Number(m[2]);
  }
  if (errors.length) return { ok: false, errors };

  const parsed = TaskFileSchema.safeParse({
    id: `issue-${issue.number}`,
    title: issue.title.trim(),
    request,
    acceptance_criteria: criteria,
    ...(scope.length ? { scope: { allowed_paths: scope } } : {}),
    ...(Object.keys(budget).length ? { budget } : {}),
  });
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "task"}: ${i.message}`),
    };
  }
  return { ok: true, task: parsed.data };
}
