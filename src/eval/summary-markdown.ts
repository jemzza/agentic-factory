import type { EvalSummary } from "./run-eval.js";

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderEvalSummaryMarkdown(s: EvalSummary): string {
  const m = s.metrics;
  const lines: string[] = [];
  lines.push(`# Eval ${s.evalId}`);
  lines.push(
    [
      `- **Started:** ${s.startedAt}  **Finished:** ${s.finishedAt}`,
      `- **Runtime / models:** ${s.runtime} — ${Object.entries(s.models)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")}`,
    ].join("\n"),
  );

  lines.push(
    "## Metrics",
    [
      "| Metric | Value |",
      "|---|---|",
      `| Verified rate (correct / total) | **${pct(m.verifiedRate)}** (${m.correct}/${m.total}) |`,
      `| False success rate (claimed success, hidden tests failed) | **${pct(m.falseSuccessRate)}** (${m.falseSuccess}/${m.successClaims}) |`,
      `| Average fix cycles (tasks that reached the developer) | ${m.avgFixCycles === null ? "n/a" : m.avgFixCycles.toFixed(2)} |`,
      `| Average time per task | ${m.avgDurationSec.toFixed(1)}s |`,
      `| Total cost | $${m.totalCostUsd.toFixed(3)}${m.unknownCostSteps ? ` (+${m.unknownCostSteps} step(s) with unknown cost)` : ""} |`,
      `| Hidden-test files found in agent worktrees | ${m.hiddenLeaks} |`,
      `| Outcomes | ${Object.entries(m.byOutcome)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")} |`,
    ].join("\n"),
  );

  lines.push(
    "## Tasks",
    [
      "| Task | Difficulty | Expected | Run status | Outcome | Correct | Hidden tests | Fix cycles | Time | Cost | Report |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
      ...s.tasks.map((t) => {
        const hidden = t.hidden
          ? t.hidden.infraError
            ? "infra error"
            : `${t.hidden.total === null ? "?" : t.hidden.total - (t.hidden.failed ?? 0)}/${t.hidden.total ?? "?"}${t.hidden.passed ? "" : " ✗"}`
          : "—";
        return `| \`${t.taskId}\` | ${t.difficulty} | ${t.expected} | ${t.status} | **${t.outcome}** | ${t.correct ? "✅" : "❌"} | ${hidden} | ${t.fixCycles} | ${(t.durationMs / 1000).toFixed(0)}s | $${t.costUsd.toFixed(3)} | ${t.reportPath ? `[report](${t.reportPath})` : "—"} |`;
      }),
    ].join("\n"),
  );

  lines.push(
    "## Definitions",
    [
      "- **verified**: the run ended in `success` *and* the hidden acceptance tests (never shown to the agent) passed on a copy of the final worktree.",
      "- **false_success**: the run ended in `success` but the hidden tests failed — the system claimed success wrongly.",
      "- **needs_clarification** is the correct outcome for tasks whose request is contradictory; it counts as correct only there.",
      "- Any other outcome is the pipeline's final status (`gate_failed`, `review_rejected`, `timeout`, `budget_exceeded`, `error`).",
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
