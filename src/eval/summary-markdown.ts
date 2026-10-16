import type { EvalSummary } from "./run-eval.js";

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const cycles = (t: EvalSummary["tasks"][number]) =>
  t.gateFixCycles === null || t.reviewCycles === null
    ? `${t.fixCycles} (not split)`
    : `${t.gateFixCycles} / ${t.reviewCycles}${t.maxReviewCycles !== null && t.reviewCycles === t.maxReviewCycles && t.maxReviewCycles > 0 ? " (review limit)" : ""}`;
const num = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderEvalSummaryMarkdown(s: EvalSummary): string {
  const m = s.metrics;
  const reachedDev = s.tasks.filter(
    (t) => t.reachedDeveloper && t.outcome !== "infra_error",
  ).length;
  const splitNote =
    m.splitCyclesKnown < reachedDev
      ? ` (${m.splitCyclesKnown} of ${reachedDev} tasks; the rest were recorded before the split)`
      : "";
  const lines: string[] = [];
  lines.push(`# Eval ${s.evalId}`);
  lines.push(
    [
      `- **Started:** ${s.startedAt}  **Finished:** ${s.finishedAt}`,
      `- **Runtime / models:** ${s.runtime} — ${Object.entries(s.models)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")}`,
      `- **Factory commit:** ${s.factoryCommit ? `\`${s.factoryCommit}\`` : "not recorded"}`,
      `- **Spec approval:** ${s.specApproval} (eval runs are unattended; manual approvals are not mixed into these metrics)`,
    ].join("\n"),
  );

  if (s.costCap?.reached) {
    lines.push(
      `> **Stopped at the eval cost cap ($${s.costCap.capUsd}).** Partial results: ` +
        `${s.costCap.skippedTasks.length} task(s) not run: ${s.costCap.skippedTasks.map((t) => `\`${t}\``).join(", ")}.`,
    );
  }
  if (s.interrupted) {
    lines.push(
      `> **Interrupted: the model provider was unavailable** (${cell(s.interrupted.reason)}). ` +
        `${s.interrupted.pendingTasks.length} task(s) pending: ${s.interrupted.pendingTasks.map((t) => `\`${t}\``).join(", ")}. ` +
        "Resume with `npm run eval -- --resume <evalId>`.",
    );
  }
  lines.push(
    "## Metrics",
    [
      "| Metric | Value |",
      "|---|---|",
      `| First-pass rate (verified with no rework / tasks whose correct outcome is an implementation) | **${pct(m.firstPassRate)}** (${m.firstPass}/${m.firstPassDenominator}) |`,
      `| Verified rate (correct / total) | **${pct(m.verifiedRate)}** (${m.correct}/${m.total}) |`,
      `| False success rate (claimed success, hidden tests failed) | **${pct(m.falseSuccessRate)}** (${m.falseSuccess}/${m.successClaims}) |`,
      `| Clarification tasks (correct outcome is needs_clarification; not in first-pass) | ${m.clarificationCorrect}/${m.clarificationTasks} answered with needs_clarification |`,
      `| Average gate fix cycles (tasks that reached the developer) | ${num(m.avgGateFixCycles)}${splitNote} |`,
      `| Average review cycles (tasks that reached the developer) | ${num(m.avgReviewCycles)}${splitNote} |`,
      `| Average fix cycles, total | ${num(m.avgFixCycles)} |`,
      `| Ended gate_failed / review_rejected | ${m.gateFailed} / ${m.reviewRejected} |`,
      `| Stopped by the review limit (review_rejected / tasks reviewed) | ${pct(m.reviewLimitStopRate)} (${m.reviewRejected}/${m.reviewed}) |`,
      `| Used the whole review budget (any outcome) | ${m.reviewBudgetExhausted} task(s) |`,
      `| Average time per task | ${m.avgDurationSec.toFixed(1)}s |`,
      `| Total cost | $${m.totalCostUsd.toFixed(3)}${m.unknownCostSteps ? ` (+${m.unknownCostSteps} step(s) with unknown cost)` : ""} |`,
      `| Hidden-test files found in agent worktrees | ${m.hiddenLeaks} |`,
      `| Excluded: provider unavailable (infra_error) | ${m.excludedInfra} task(s)${s.replacedCostUsd ? `; $${s.replacedCostUsd.toFixed(3)} spent on attempts replaced by a resume` : ""} |`,
      `| Outcomes | ${Object.entries(m.byOutcome)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")} |`,
    ].join("\n"),
  );

  lines.push(
    "## Tasks",
    [
      "| Task | Difficulty | Expected | Run status | Outcome | Correct | Hidden tests | Cycles gate / review | First pass | Time | Cost | Report |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|",
      ...s.tasks.map((t) => {
        const hidden = t.hidden
          ? t.hidden.infraError
            ? "infra error"
            : `${t.hidden.total === null ? "?" : t.hidden.total - (t.hidden.failed ?? 0)}/${t.hidden.total ?? "?"}${t.hidden.passed ? "" : " ✗"}`
          : "—";
        return `| \`${t.taskId}\` | ${t.difficulty} | ${t.expected} | ${t.status} | **${t.outcome}** | ${t.correct ? "✅" : "❌"} | ${hidden} | ${cycles(t)} | ${t.firstPass === null ? "—" : t.firstPass ? "yes" : "no"} | ${(t.durationMs / 1000).toFixed(0)}s | $${t.costUsd.toFixed(3)} | ${t.reportPath ? `[report](${t.reportPath})` : "—"} |`;
      }),
    ].join("\n"),
  );

  lines.push(
    "## Definitions",
    [
      "- **first pass**: the task's correct outcome is an implementation, the hidden tests passed (verified), and the developer never reworked it — 0 gate fix cycles and 0 review cycles. Spec revisions by a human do not count. The denominator excludes contradictory tasks (correct outcome `needs_clarification`, shown on their own line) and `infra_error`.",
      "- **Cycle budgets**: a gate fix cycle follows a failed quality gate (`max_gate_fix_cycles`), a review cycle follows reviewer `request_changes` (`max_review_cycles`); they are capped separately. Runs recorded before the split have only the total.",
      "- **verified**: the run ended in `success` *and* the hidden acceptance tests (never shown to the agent) passed on a copy of the final worktree.",
      "- **false_success**: the run ended in `success` but the hidden tests failed — the system claimed success wrongly.",
      "- **needs_clarification** is the correct outcome for tasks whose request is contradictory; it counts as correct only there.",
      "- Any other outcome is the pipeline's final status (`gate_failed`, `review_rejected`, `timeout`, `budget_exceeded`, `error`).",
      "- **infra_error**: the model provider refused the call (usage/rate limit, outage). It says nothing about the factory, so it is excluded from every metric and re-run on resume.",
      "- Costs are list-price estimates reported by the agent CLI.",
    ].join("\n"),
  );

  const notes = s.tasks.filter((t) => !t.correct);
  if (notes.length) {
    lines.push(
      "## Details for incorrect outcomes",
      notes
        .map((t) => {
          const parts = [`### \`${t.taskId}\` — ${t.outcome}`, cell(t.message)];
          if (t.hidden && !t.hidden.passed)
            parts.push("Hidden tests output (tail):", "```\n" + t.hidden.outputTail + "\n```");
          if (t.hiddenLeaks.length)
            parts.push(`**Hidden files in worktree:** ${t.hiddenLeaks.join(", ")}`);
          return parts.join("\n\n");
        })
        .join("\n\n"),
    );
  }
  return lines.join("\n\n") + "\n";
}
