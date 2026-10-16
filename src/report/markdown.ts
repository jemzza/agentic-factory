import type { RunReport, StepResult } from "../schemas/report.js";
import { cycleLimits } from "../schemas/task.js";

function fixCycleLimits(r: RunReport): string {
  const limits = cycleLimits(r.task.budget);
  return limits
    ? `(limits: ${limits.gateFix} gate fix, ${limits.review} review)`
    : `of ${"max_fix_cycles" in r.task.budget ? r.task.budget.max_fix_cycles : "?"} (legacy shared limit)`;
}

const STATUS_ICON: Record<RunReport["status"], string> = {
  success: "✅",
  gate_failed: "❌",
  review_rejected: "❌",
  needs_clarification: "❓",
  timeout: "⏱️",
  budget_exceeded: "💸",
  error: "💥",
  infra_error: "🔌",
};

const fence = (body: string, lang = "") => {
  // Use a fence longer than any backtick run inside the body.
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${body.replace(/\s+$/, "")}\n${f}`;
};

const usd = (n: number | null) => (n === null ? "?" : `$${n.toFixed(3)}`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function stepRow(step: StepResult): string {
  switch (step.kind) {
    case "agent":
      return `| ${step.cycle} | ${step.role} | ${step.ok ? "ok" : `**${step.error?.kind ?? "failed"}**`} | ${secs(step.durationMs)} | ${usd(step.costUsd)} | ${step.tokens ? `${step.tokens.input} / ${step.tokens.output}` : "?"} | ${step.permissionDenials.length} | \`${step.rawLogPath}\` |`;
    case "spec":
      return `| 0 | spec draft #${step.attempt} | ${step.valid ? "valid" : `**invalid** (${step.issues.length} issue(s))`} | | | | | ${step.commit ? `\`${step.commit.slice(0, 10)}\`` : ""} |`;
    case "snapshot":
      return `| ${step.cycle} | snapshot | \`${step.commit.slice(0, 10)}\` | | | | | |`;
    case "gate":
      return `| ${step.cycle} | gate | ${step.result.passed ? "passed" : "**failed**"} | ${secs(step.durationMs)} | | | | ${step.result.checks.map((c) => `${c.name}: ${c.passed ? "ok" : "fail"}`).join(", ")} |`;
  }
}

export function renderReportMarkdown(r: RunReport): string {
  const out: string[] = [];
  out.push(`# ${STATUS_ICON[r.status]} ${r.task.title} — \`${r.status}\``);
  out.push(
    [
      `- **Run:** \`${r.runId}\``,
      `- **Task:** \`${r.task.id}\``,
      `- **Result:** ${r.message}`,
      r.activeDurationMs !== undefined && r.wallDurationMs !== undefined
        ? `- **Time:** ${secs(r.activeDurationMs)} active of the ${r.task.budget.timeout_minutes} min limit; ${secs(r.wallDurationMs)} wall-clock` +
          (r.wallDurationMs - r.activeDurationMs >= 1000
            ? ` (includes ${secs(r.wallDurationMs - r.activeDurationMs)} waiting for a human or interrupted, not counted against the limit)`
            : "")
        : `- **Time:** ${secs(r.durationMs)} (limit ${r.task.budget.timeout_minutes} min)`,
      `- **Cost:** ${usd(r.cost.totalUsd)} of ${usd(r.cost.budgetUsd)}${r.cost.unknownCostSteps ? ` (+${r.cost.unknownCostSteps} step(s) with unknown cost)` : ""}`,
      `- **Fix cycles:** ${r.fixCycles} ${fixCycleLimits(r)}`,
      `- **Runtime / models:** ${r.runtime} — ${Object.entries(r.models)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")}`,
      r.worktree
        ? `- **Worktree:** \`${r.worktree.path}\` (branch \`${r.worktree.branch}\`, head \`${r.worktree.headCommit?.slice(0, 10) ?? "?"}\`)`
        : "",
      r.target
        ? `- **Base:** \`${r.target.baseCommit.slice(0, 10)}\` in \`${r.target.repoDir}\``
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  if (r.status === "success") {
    out.push(
      "> The change passed the sandboxed checks and an independent review. **A human must review and merge it.**",
    );
  }

  out.push(
    "## Task",
    r.task.request.trim(),
    "### Acceptance criteria",
    r.task.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n"),
  );

  if (r.plan) {
    out.push("## Plan", r.plan.plan.trim());
    if (r.plan.questions.length)
      out.push("### Questions for a human", r.plan.questions.map((q) => `- ${q}`).join("\n"));
    if (r.plan.risks.length) out.push("### Risks", r.plan.risks.map((q) => `- ${q}`).join("\n"));
  }

  if (r.spec) {
    out.push(
      `## Specification (OpenSpec \`openspec/changes/${r.spec.changeId}\`)`,
      [
        `- **Approval:** ${r.spec.approvalMode}`,
        `- **Validation:** ${r.spec.valid ? "valid" : "invalid"} after ${r.spec.attempts} attempt(s)`,
        `- **Spec commit:** ${r.spec.commit ? `\`${r.spec.commit.slice(0, 10)}\`` : "—"}`,
        r.spec.rejections.length
          ? `- **Rejected by a human ${r.spec.rejections.length} time(s):** ${r.spec.rejections.map((c) => `“${cell(c)}”`).join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      ...Object.entries(r.spec.files)
        .filter(([p]) => p.endsWith(".md"))
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([p, content]) => [`### \`${p}\``, fence(content, "markdown")]),
    );
  }

  out.push(
    "## Steps",
    [
      "| Cycle | Step | Result | Time | Cost | Tokens in/out | Denied tools | Details |",
      "|---|---|---|---|---|---|---|---|",
      ...r.steps.map(stepRow),
    ].join("\n"),
  );

  const errors = r.steps.filter((s) => s.kind === "agent" && s.error);
  if (errors.length) {
    out.push(
      "### Agent errors",
      errors
        .map((s) =>
          s.kind === "agent" && s.error
            ? `- ${s.role} (cycle ${s.cycle}): **${s.error.kind}** — ${s.error.message}`
            : "",
        )
        .join("\n"),
    );
  }
  const denials = r.steps.flatMap((s) =>
    s.kind === "agent"
      ? s.permissionDenials.map((d) => ({ role: s.role, cycle: s.cycle, ...d }))
      : [],
  );
  if (denials.length) {
    out.push(
      "### Denied tool calls",
      denials
        .map(
          (d) =>
            `- ${d.role} (cycle ${d.cycle}): \`${d.tool}\` ${cell(JSON.stringify(d.input)).slice(0, 200)}`,
        )
        .join("\n"),
    );
  }

  const gates = r.steps.filter(
    (s): s is Extract<StepResult, { kind: "gate" }> => s.kind === "gate",
  );
  if (gates.length) {
    out.push("## Quality Gate (sandbox, `--network none`)");
    for (const g of gates) {
      const sc = g.result.scope;
      out.push(
        `### Cycle ${g.cycle}: ${g.result.passed ? "passed" : "failed"}`,
        `**Scope:** ${sc.passed ? "ok" : "failed"} — ${sc.changedFiles.length} changed file(s)${sc.empty ? " (no changes)" : ""}${sc.violations.length ? `; outside allowed paths: ${sc.violations.map((v) => `\`${v}\``).join(", ")}` : ""}`,
      );
      for (const c of g.result.checks) {
        out.push(
          `**\`$ ${c.command.join(" ")}\`** → exit ${c.exitCode ?? "null"}${c.timedOut ? " (timed out)" : ""}, ${secs(c.durationMs)} — full log: \`${c.logPath}\``,
          fence(c.outputTail),
        );
      }
    }
  }

  const reviews = r.steps.filter(
    (s): s is Extract<StepResult, { kind: "agent" }> =>
      s.kind === "agent" && s.role === "reviewer" && s.ok,
  );
  if (r.review) {
    out.push(
      `## Review (final verdict: \`${r.review.verdict}\`${reviews.length > 1 ? `, ${reviews.length} reviews in total` : ""})`,
      [
        "| # | Criterion | Met | Evidence |",
        "|---|---|---|---|",
        ...r.review.criteria_check.map(
          (c, i) =>
            `| ${i + 1} | ${cell(c.criterion)} | ${c.met ? "✅" : "❌"} | ${cell(c.evidence)} |`,
        ),
      ].join("\n"),
    );
    if (r.review.issues.length) {
      out.push(
        "### Issues",
        r.review.issues
          .map((i) => `- **${i.severity}** ${i.file ? `\`${i.file}\`: ` : ""}${i.description}`)
          .join("\n"),
      );
    }
  }

  out.push(
    "## Diff",
    r.changedFiles.length ? r.changedFiles.map((f) => `- \`${f}\``).join("\n") : "_No changes._",
  );
  if (r.diff) out.push(fence(r.diff, "diff"));
  return out.join("\n\n") + "\n";
}
