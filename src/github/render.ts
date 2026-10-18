import { createHash } from "node:crypto";
import type { RunReport } from "../schemas/report.js";
import type { PersistedSpecChange } from "../schemas/spec.js";
import { BOT_MARKER } from "./commands.js";

/*
 * Everything the factory writes on GitHub. Every comment starts with BOT_MARKER (never parsed
 * as a command), followed by a machine-readable marker for idempotent publishing:
 *   <!-- factory:run=<runId> kind=<kind> [version=<n> hash=<12 hex>] -->
 */

/** GitHub's limit for a comment or PR body is 65,536 characters; keep a margin. */
export const MAX_BODY = 60_000;

export const LABELS = {
  trigger: "factory",
  specReview: "factory:spec-review",
  inProgress: "factory:in-progress",
  prOpen: "factory:pr-open",
  needsClarification: "factory:needs-clarification",
  failed: "factory:failed",
  paused: "factory:paused",
  done: "factory:done",
} as const;
export const STATUS_LABELS = Object.values(LABELS).filter((l) => l !== LABELS.trigger);
export const LABEL_COLORS: Record<string, string> = {
  [LABELS.trigger]: "5319e7",
  [LABELS.specReview]: "fbca04",
  [LABELS.inProgress]: "1d76db",
  [LABELS.prOpen]: "0e8a16",
  [LABELS.needsClarification]: "d93f0b",
  [LABELS.failed]: "b60205",
  [LABELS.paused]: "c5def5",
  [LABELS.done]: "006b75",
};

export function metaMarker(
  runId: string,
  kind: string,
  extra: Record<string, string> = {},
): string {
  const fields = Object.entries(extra)
    .map(([k, v]) => ` ${k}=${v}`)
    .join("");
  return `<!-- factory:run=${runId} kind=${kind}${fields} -->`;
}

export function hasMeta(body: string, runId: string, kind: string): boolean {
  return body.includes(`<!-- factory:run=${runId} kind=${kind}`);
}

function comment(
  runId: string,
  kind: string,
  text: string,
  extra: Record<string, string> = {},
): string {
  const body = `${BOT_MARKER}\n${metaMarker(runId, kind, extra)}\n${text.trim()}\n`;
  return body.length <= MAX_BODY ? body : `${body.slice(0, MAX_BODY - 40)}\n\n… (truncated)\n`;
}

/** Version hash of a spec: sha256 over the rendered files (path and content), 12 hex chars. */
export function specHash(files: Readonly<Record<string, string>>): string {
  const h = createHash("sha256");
  for (const p of Object.keys(files).sort()) h.update(`${p}\0${files[p] ?? ""}\0`);
  return h.digest("hex").slice(0, 12);
}

/** The published specification, with its version and hash and the command hint. */
export function specComment(o: {
  runId: string;
  version: number;
  hash: string;
  spec: PersistedSpecChange;
}): string {
  const req = o.spec.capabilities.flatMap((c) => c.requirements.map((r) => ({ cap: c.path, r })));
  const fmt = ({ cap, r }: (typeof req)[number]) =>
    [
      `- **${r.name}** (\`${cap}\`, source \`${r.source ?? "unknown"}\`) — ${r.text}`,
      ...r.scenarios.map((s) => `  - _${s.name}_: WHEN ${s.when} THEN ${s.then}`),
    ].join("\n");
  const fromCriteria = req.filter((x) => (x.r.source ?? "").startsWith("acceptance:"));
  const outside = req.filter((x) => !(x.r.source ?? "").startsWith("acceptance:"));
  return comment(
    o.runId,
    "spec",
    [
      `## Specification v${o.version} · hash \`${o.hash}\``,
      `**Why.** ${o.spec.why}`,
      "**What changes**",
      o.spec.what_changes.map((w) => `- ${w}`).join("\n"),
      "### Requirements from the acceptance criteria",
      fromCriteria.length ? fromCriteria.map(fmt).join("\n") : "_None._",
      "### Requirements outside the acceptance criteria",
      outside.length
        ? `${outside.map(fmt).join("\n")}\n\nThese keep existing behavior; check them too.`
        : "_None._",
      `**Impact.** ${o.spec.impact}`,
      "---",
      [
        "Reply with a comment whose first line is a command (only from an allowed user):",
        "- `/approve` — implement this version (optionally `/approve " + o.hash + "`)",
        "- `/reject <what to change>` — send it back to planning",
        "An approval counts only for this version and only if written after this comment.",
      ].join("\n"),
    ].join("\n\n"),
    { version: String(o.version), hash: o.hash },
  );
}

export function questionsComment(
  runId: string,
  questions: readonly string[],
  message: string,
): string {
  return comment(
    runId,
    "questions",
    [
      "## The factory needs clarification",
      message,
      questions.length ? questions.map((q, i) => `${i + 1}. ${q}`).join("\n") : "",
      "Answer in this issue or edit the issue, then comment `/retry` to start again.",
    ].join("\n\n"),
  );
}

export function invalidIssueComment(issue: number, errors: readonly string[]): string {
  return comment(
    `issue-${issue}`,
    "invalid",
    [
      "## This issue is not a valid factory task",
      errors.map((e) => `- ${e}`).join("\n"),
      "Fix the issue (use the *Factory task* template), then comment `/retry`.",
    ].join("\n\n"),
  );
}

export function statusComment(runId: string, kind: string, title: string, text: string): string {
  return comment(runId, kind, `## ${title}\n\n${text}`);
}

export function replyComment(runId: string, text: string): string {
  return comment(runId, "reply", text);
}

function splitDiff(diff: string): { spec: string; code: string } {
  const parts = diff.split(/(?=^diff --git )/m).filter((p) => p.trim() !== "");
  const isSpec = (p: string) => /^diff --git a\/openspec\//.test(p);
  return {
    spec: parts.filter(isSpec).join(""),
    code: parts.filter((p) => !isSpec(p)).join(""),
  };
}

const fence = (s: string, lang = "") => `\`\`\`${lang}\n${s.trimEnd()}\n\`\`\``;

/** PR description: spec, split diffs, gate per command, review per cycle, cycles, cost, time. */
export function prBody(o: {
  report: RunReport;
  issue: number;
  specHashValue: string | null;
}): string {
  const r = o.report;
  const { spec, code } = splitDiff(r.diff);
  const gates = r.steps.flatMap((s) => (s.kind === "gate" ? [s] : []));
  const reviews = r.steps.flatMap((s) => (s.kind === "agent" && s.role === "reviewer" ? [s] : []));
  const min = (ms: number | undefined) => `${Math.round((ms ?? 0) / 600) / 100} min`;
  const sections = [
    `Closes #${o.issue}.`,
    `Factory run \`${r.runId}\` · task \`${r.task.id}\`${o.specHashValue ? ` · spec hash \`${o.specHashValue}\`` : ""}`,
    "## Specification",
    r.spec?.change
      ? r.spec.change.capabilities
          .flatMap((c) =>
            c.requirements.map((q) => `- **${q.name}** (\`${q.source ?? "unknown"}\`) — ${q.text}`),
          )
          .join("\n")
      : "_none_",
    "## Quality gate (run by the factory in the sandbox, not by the agent)",
    gates
      .map(
        (g) =>
          `**Cycle ${g.cycle}: ${g.result.passed ? "passed" : "failed"}**\n` +
          g.result.checks
            .map(
              (c) =>
                `- \`${c.command.join(" ")}\` → ${c.timedOut ? "timed out" : `exit ${c.exitCode ?? "?"}`}`,
            )
            .join("\n") +
          (g.result.policyViolations.length
            ? `\n- policy: ${g.result.policyViolations.join("; ")}`
            : "") +
          (g.result.scope.violations.length
            ? `\n- scope: ${g.result.scope.violations.join(", ")}`
            : ""),
      )
      .join("\n\n") || "_no gate run_",
    "## Review",
    reviews
      .map((s) => {
        let verdict = "invalid answer";
        try {
          const v = JSON.parse(s.output) as {
            verdict?: string;
            issues?: { severity?: string; description?: string }[];
          };
          verdict = `${v.verdict ?? "?"}${v.issues?.length ? `, ${v.issues.length} issue(s): ${v.issues.map((i) => `${i.severity ?? "?"} — ${i.description ?? ""}`).join("; ")}` : ""}`;
        } catch {
          // keep "invalid answer"
        }
        return `- cycle ${s.cycle}: ${verdict}`;
      })
      .join("\n") || "_no review_",
    "## Run",
    [
      `- Gate fix cycles: ${r.gateFixCycles ?? 0}, review cycles: ${r.reviewCycles ?? 0}, spec revisions: ${r.specRevisions ?? 0}`,
      `- Cost: $${r.cost.totalUsd.toFixed(3)} (budget $${r.cost.budgetUsd})`,
      `- Active time: ${min(r.activeDurationMs)}, wall time: ${min(r.wallDurationMs)}`,
    ].join("\n"),
    "## Diff: specification (`openspec/`)",
    spec ? fence(spec, "diff") : "_none_",
    "## Diff: code",
    code ? fence(code, "diff") : "_none_",
    "---",
    "Comment `/merge` to merge (the gate runs again on the merge result first), or `/close <reason>`.",
  ];
  let body = `${BOT_MARKER}\n${metaMarker(r.runId, "pr")}\n${sections.join("\n\n")}\n`;
  if (body.length > MAX_BODY) {
    // Diffs are the large part; the full diff stays in the branch and the report.
    const head = sections
      .slice(0, sections.indexOf("## Diff: specification (`openspec/`)"))
      .join("\n\n");
    body = `${BOT_MARKER}\n${metaMarker(r.runId, "pr")}\n${head}\n\n_Diffs are too large for the description; see the Files tab._\n\n---\n\nComment \`/merge\` to merge (the gate runs again on the merge result first), or \`/close <reason>\`.\n`;
  }
  return body;
}
