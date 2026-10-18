import type { RepeatedSummary, Stat } from "../eval/repeat.js";
import type { RunReport } from "../schemas/report.js";
import type {
  ApprovalRow,
  EvalRow,
  EventRow,
  RunRow,
  SpecVersionRow,
  StepRow,
} from "../store/store.js";
import type { EvalView, Unreadable } from "./data.js";
import { html, query, trusted, type Html } from "./html.js";

const STYLE = `
:root { color-scheme: light dark; --fg:#1b1f24; --muted:#59636e; --bg:#fff; --line:#d1d9e0;
  --ok:#1a7f37; --bad:#cf222e; --warn:#9a6700; --code:#f6f8fa; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --muted:#9198a1; --bg:#0d1117;
  --line:#3d444d; --ok:#3fb950; --bad:#f85149; --warn:#d29922; --code:#161b22; } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 1200px; padding: 16px; font: 14px/1.5 system-ui, sans-serif;
  color: var(--fg); background: var(--bg); }
nav { display: flex; gap: 16px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
nav b { margin-right: auto; }
a { color: inherit; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line);
  vertical-align: top; white-space: nowrap; }
td.wrap { white-space: normal; min-width: 240px; }
th { color: var(--muted); font-weight: 600; }
pre { background: var(--code); padding: 8px; overflow-x: auto; font-size: 12px;
  max-height: 600px; }
.muted { color: var(--muted); } .ok { color: var(--ok); } .bad { color: var(--bad); }
.warn { color: var(--warn); }
form { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; margin: 12px 0; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; }
dt { color: var(--muted); } dd { margin: 0; }
`;

export function layout(title: string, body: Html): Html {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · Factory dashboard</title>
        <style>
          ${trusted(STYLE)}
        </style>
      </head>
      <body>
        <nav>
          <b>Factory dashboard</b><a href="/">Runs</a><a href="/evals">Evals</a>
          <span class="muted">read-only</span>
        </nav>
        ${body}
      </body>
    </html>`;
}

const STATUS_CLASS: Record<string, string> = {
  success: "ok",
  merged: "ok",
  closed: "muted",
  verified: "ok",
  completed: "ok",
  running: "warn",
  awaiting_spec_approval: "warn",
  awaiting_merge_approval: "warn",
  infra_error: "warn",
  interrupted: "warn",
};
const status = (s: string) => html`<span class="${STATUS_CLASS[s] ?? "bad"}">${s}</span>`;
const usd = (x: number | null | undefined) =>
  x === null || x === undefined ? "—" : `$${x.toFixed(2)}`;
const when = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 19) : "—");

function ghLinks(run: RunRow, repo: string | undefined): Html {
  if (!repo) return html`<span class="muted">—</span>`;
  const base = `https://github.com/${repo}`;
  return html`${
    run.issue_number !== null
      ? html`<a href="${base}/issues/${run.issue_number}">#${run.issue_number}</a>`
      : ""
  }
  ${run.pr_number !== null ? html` · <a href="${base}/pull/${run.pr_number}">PR #${run.pr_number}</a>` : ""}`;
}

export interface RunsFilter {
  project: string | null;
  status: string | null;
}

export function runsPage(
  runs: readonly RunRow[],
  opts: {
    projects: readonly string[];
    statuses: readonly string[];
    filter: RunsFilter;
    repos: Record<string, string>;
  },
): Html {
  const opt = (v: string, cur: string | null) =>
    html`<option value="${v}" ${v === cur ? html`selected` : ""}>${v}</option>`;
  return layout(
    "Runs",
    html`<h1>Runs</h1>
      <form method="get" action="/">
        <label
          >Project<br /><select name="project">
            <option value="">all</option>
            ${opts.projects.map((p) => opt(p, opts.filter.project))}
          </select></label
        >
        <label
          >Status<br /><select name="status">
            <option value="">all</option>
            ${opts.statuses.map((s) => opt(s, opts.filter.status))}
          </select></label
        >
        <button type="submit">Filter</button>
      </form>
      <p class="muted">${runs.length} run(s), most recent first.</p>
      <table>
        <tr>
          <th>Run</th>
          <th>Project</th>
          <th>Task</th>
          <th>Mode</th>
          <th>Status</th>
          <th>GitHub</th>
          <th>Cycles gate/review</th>
          <th>Cost</th>
          <th>Started</th>
        </tr>
        ${runs.map(
          (r) =>
            html`<tr>
              <td><a href="/runs/${r.id}">${r.id}</a></td>
              <td>${r.project_id}</td>
              <td>${r.task_id}</td>
              <td>${r.mode}${r.eval_id ? html` <span class="muted">${r.eval_id}</span>` : ""}</td>
              <td>${status(r.status)}</td>
              <td>${ghLinks(r, opts.repos[r.project_id])}</td>
              <td>${r.gate_fix_cycles ?? "—"} / ${r.review_cycles ?? "—"}</td>
              <td>${usd(r.cost_usd)}</td>
              <td>${when(r.started_at)}</td>
            </tr>`,
        )}
      </table>`,
  );
}

/** Event payloads can be large (conventions, prompts): show keys and a short preview. */
function payloadPreview(payload: string | null): string {
  if (!payload) return "";
  return payload.length > 400
    ? `${payload.slice(0, 400)}… (${String(payload.length)} chars)`
    : payload;
}

function reviewSection(r: RunReport): Html {
  if (!r.review) return html`<p class="muted">No review.</p>`;
  return html`<p>
      Verdict: ${status(r.review.verdict === "approve" ? "success" : "request_changes")}
      (${r.reviewCycles ?? 0} review cycle(s))
    </p>
    ${
      r.review.issues.length
        ? html`<table>
            <tr>
              <th>Severity</th>
              <th>File</th>
              <th>Issue</th>
            </tr>
            ${r.review.issues.map(
              (i) =>
                html`<tr>
                  <td>${i.severity}</td>
                  <td>${i.file}</td>
                  <td class="wrap">${i.description}</td>
                </tr>`,
            )}
          </table>`
        : html`<p class="muted">No issues.</p>`
    }
    ${
      r.review.criteria_check.length
        ? html`<table>
            <tr>
              <th>Criterion</th>
              <th>Met</th>
              <th>Evidence</th>
            </tr>
            ${r.review.criteria_check.map(
              (c) =>
                html`<tr>
                  <td class="wrap">${c.criterion}</td>
                  <td>
                    ${c.met ? html`<span class="ok">yes</span>` : html`<span class="bad">no</span>`}
                  </td>
                  <td class="wrap">${c.evidence}</td>
                </tr>`,
            )}
          </table>`
        : ""
    }`;
}

function gateSection(r: RunReport): Html {
  if (!r.gate) return html`<p class="muted">The gate did not run.</p>`;
  return html`<p>
      Gate:
      ${r.gate.passed ? html`<span class="ok">passed</span>` : html`<span class="bad">failed</span>`}
      · gate fix cycles ${r.gateFixCycles ?? r.fixCycles}
    </p>
    <table>
      <tr>
        <th>Check</th>
        <th>Command</th>
        <th>Exit</th>
        <th>Time</th>
      </tr>
      ${r.gate.checks.map(
        (c) =>
          html`<tr>
            <td>
              ${c.passed ? html`<span class="ok">${c.name}</span>` : html`<span class="bad">${c.name}</span>`}
            </td>
            <td>${c.command.join(" ")}</td>
            <td>${c.timedOut ? "timeout" : (c.exitCode ?? "—")}</td>
            <td>${(c.durationMs / 1000).toFixed(1)}s</td>
          </tr>`,
      )}
    </table>
    ${r.gate.checks
      .filter((c) => !c.passed)
      .map(
        (c) =>
          html`<h3>${c.name}</h3>
            <pre>${c.outputTail}</pre>`,
      )}
    ${
      r.gate.policyViolations.length
        ? html`<p class="bad">Policy: ${r.gate.policyViolations.join("; ")}</p>`
        : ""
    }`;
}

function specSection(r: RunReport | null, notice: string | null): Html {
  if (r?.spec) {
    const files = Object.entries(r.spec.files);
    return html`<p>
        Change <code>${r.spec.changeId}</code>, approval ${r.spec.approvalMode},
        ${r.spec.valid ? "valid" : html`<span class="bad">invalid</span>`}, ${r.spec.attempts}
        attempt(s), ${r.spec.rejections.length} human rejection(s)
      </p>
      ${r.spec.rejections.map(
        (c, i) =>
          html`<p>Rejection ${i + 1}:</p>
            <pre>${c}</pre>`,
      )}
      ${files.map(
        ([name, text]) =>
          html`<h3>${name}</h3>
            <pre>${text}</pre>`,
      )}`;
  }
  if (notice)
    return html`<p class="muted">Waiting for approval:</p>
      <pre>${notice}</pre>`;
  return html`<p class="muted">No spec.</p>`;
}

export function runPage(d: {
  run: RunRow;
  repo: string | undefined;
  steps: readonly StepRow[];
  events: readonly EventRow[];
  approvals: readonly ApprovalRow[];
  specVersions: readonly SpecVersionRow[];
  report: RunReport | Unreadable | null;
  notice: string | null;
}): Html {
  const { run } = d;
  const report = d.report && "problem" in d.report ? null : d.report;
  const problem = d.report && "problem" in d.report ? d.report.problem : null;
  const roles = Object.entries(run.roles_json)
    .map(([k, v]) => `${k}=${v.runtime}:${v.model}`)
    .join(", ");
  return layout(
    `Run ${run.id}`,
    html`<h1>Run ${run.id}</h1>
      <dl>
        <dt>Status</dt>
        <dd>${status(run.status)} <span class="muted">${run.status_message}</span></dd>
        <dt>Project / task</dt>
        <dd>${run.project_id} / ${run.task_id}</dd>
        <dt>Mode</dt>
        <dd>
          ${run.mode}${run.eval_id ? ` (${run.eval_id}, repeat ${String(run.eval_repeat ?? "?")})` : ""}
        </dd>
        <dt>GitHub</dt>
        <dd>${ghLinks(run, d.repo)}</dd>
        <dt>Roles</dt>
        <dd>${roles}</dd>
        <dt>Cycles</dt>
        <dd>
          gate ${run.gate_fix_cycles ?? "—"}, review ${run.review_cycles ?? "—"}, spec revisions
          ${run.spec_revisions ?? "—"}
        </dd>
        <dt>Cost</dt>
        <dd>
          ${usd(run.cost_usd)} of
          ${usd(run.budget_usd)}${run.unknown_cost_steps ? ` (${String(run.unknown_cost_steps)} step(s) of unknown cost)` : ""}
        </dd>
        <dt>Branch</dt>
        <dd>
          ${run.branch ?? "—"}
          <span class="muted"
            >${run.base_commit?.slice(0, 12) ?? ""}…${run.head_commit?.slice(0, 12) ?? ""}</span
          >
        </dd>
        <dt>Started / finished</dt>
        <dd>${when(run.started_at)} / ${when(run.finished_at)}</dd>
        ${
          report?.memory
            ? html`<dt>Memory</dt>
                <dd>
                  ${report.memory.status}, ${report.memory.used.length} record(s)
                  used${report.memory.note ? ` — ${report.memory.note}` : ""}
                </dd>`
            : ""
        }
      </dl>
      ${problem ? html`<p class="bad">Report not shown: ${problem}</p>` : ""}

      <h2>Approvals</h2>
      ${
        d.approvals.length
          ? html`<table>
              <tr>
                <th>Time</th>
                <th>Gate</th>
                <th>Decision</th>
                <th>Actor</th>
                <th>Channel</th>
                <th>Comment</th>
              </tr>
              ${d.approvals.map(
                (a) =>
                  html`<tr>
                    <td>${when(a.decided_at)}</td>
                    <td>${a.gate}</td>
                    <td>${a.decision}</td>
                    <td>${a.actor}</td>
                    <td>${a.channel}</td>
                    <td class="wrap">${a.comment ?? ""}</td>
                  </tr>`,
              )}
            </table>`
          : html`<p class="muted">None.</p>`
      }
      ${
        d.specVersions.length
          ? html`<p class="muted">
              Spec versions:
              ${d.specVersions.map((v) => `v${String(v.version)} ${v.hash.slice(0, 12)} (${when(v.published_at)})`).join(", ")}
            </p>`
          : ""
      }

      <h2>Spec</h2>
      ${specSection(report, d.notice)}

      <h2>Diff</h2>
      ${
        report
          ? report.diff
            ? html`<p class="muted">
                  ${report.changedFiles.length} file(s): ${report.changedFiles.join(", ")}
                </p>
                <pre>${report.diff}</pre>`
            : html`<p class="muted">Empty.</p>`
          : html`<p class="muted">No report yet.</p>`
      }

      <h2>Gate</h2>
      ${report ? gateSection(report) : html`<p class="muted">No report yet.</p>`}

      <h2>Review</h2>
      ${report ? reviewSection(report) : html`<p class="muted">No report yet.</p>`}

      <h2>Steps</h2>
      <table>
        <tr>
          <th>Node</th>
          <th>Cycle</th>
          <th>Attempt</th>
          <th>Status</th>
          <th>Time</th>
          <th>Cost</th>
          <th>Model</th>
          <th>Error</th>
        </tr>
        ${d.steps.map(
          (s) =>
            html`<tr>
              <td>${s.node}</td>
              <td>${s.cycle}</td>
              <td>${s.attempt}</td>
              <td>${status(s.status === "ok" ? "success" : s.status)}</td>
              <td>${s.duration_ms === null ? "—" : `${(s.duration_ms / 1000).toFixed(1)}s`}</td>
              <td>${usd(s.cost_usd)}</td>
              <td>${s.runtime ? `${s.runtime}:${s.model ?? "?"}` : ""}</td>
              <td class="wrap">
                ${s.error_kind ? `${s.error_kind}: ${s.error_message ?? ""}` : ""}
              </td>
            </tr>`,
        )}
      </table>

      <h2>Events</h2>
      <table>
        <tr>
          <th>Time</th>
          <th>Kind</th>
          <th>Node</th>
          <th>Next</th>
          <th>Payload</th>
        </tr>
        ${d.events.map(
          (e) =>
            html`<tr>
              <td>${when(e.ts)}</td>
              <td>${e.kind}</td>
              <td>${e.node ?? ""}</td>
              <td>${e.next ?? ""}</td>
              <td class="wrap"><code>${payloadPreview(e.payload)}</code></td>
            </tr>`,
        )}
      </table>`,
  );
}

export function evalsPage(evals: readonly EvalRow[]): Html {
  return layout(
    "Evals",
    html`<h1>Evals</h1>
      <form method="get" action="/evals/compare">
        <label
          >Eval A<br /><select name="a">
            ${evals.map((e) => html`<option value="${e.id}">${e.id}</option>`)}
          </select></label
        >
        <label
          >Eval B<br /><select name="b">
            ${evals.map((e) => html`<option value="${e.id}">${e.id}</option>`)}
          </select></label
        >
        <button type="submit">Compare</button>
        <span class="muted">only evals with the same baseline commit</span>
      </form>
      <table>
        <tr>
          <th>Eval</th>
          <th>Kind</th>
          <th>Project</th>
          <th>Status</th>
          <th>Repeats</th>
          <th>Baseline</th>
          <th>Cost</th>
          <th>Started</th>
        </tr>
        ${evals.map(
          (e) =>
            html`<tr>
              <td><a href="/evals/${e.id}">${e.id}</a></td>
              <td>
                ${e.kind}${e.source_eval_id ? html` <span class="muted">of ${e.source_eval_id}</span>` : ""}
              </td>
              <td>${e.project_id}</td>
              <td>${status(e.status)}</td>
              <td>${e.repeat_count}</td>
              <td><code>${e.baseline_commit.slice(0, 12)}</code></td>
              <td>${usd(e.cost_usd)}</td>
              <td>${when(e.started_at)}</td>
            </tr>`,
        )}
      </table>`,
  );
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const fmt = (x: number | null, unit: "pct" | "num" | "usd" | "sec") =>
  x === null
    ? "n/a"
    : unit === "pct"
      ? pct(x)
      : unit === "usd"
        ? `$${x.toFixed(2)}`
        : unit === "sec"
          ? `${x.toFixed(0)}s`
          : x.toFixed(2);
const statText = (s: Stat, unit: "pct" | "num" | "usd" | "sec") =>
  s.n === 0 ? "n/a" : `${fmt(s.mean, unit)}${s.stdev !== null ? ` ± ${fmt(s.stdev, unit)}` : ""}`;

const METRICS: [keyof RepeatedSummary["metrics"], string, "pct" | "num" | "usd" | "sec"][] = [
  ["verifiedRate", "Verified rate", "pct"],
  ["falseSuccessRate", "False success rate", "pct"],
  ["firstPassRate", "First-pass rate", "pct"],
  ["avgGateFixCycles", "Avg gate fix cycles", "num"],
  ["avgReviewCycles", "Avg review cycles", "num"],
  ["avgDurationSec", "Avg duration", "sec"],
  ["totalCostUsd", "Cost per repeat", "usd"],
];

function evalHeader(e: EvalRow): Html {
  return html`<dl>
    <dt>Status</dt>
    <dd>${status(e.status)}</dd>
    <dt>Project</dt>
    <dd>${e.project_id}</dd>
    <dt>Baseline</dt>
    <dd><code>${e.baseline_commit}</code></dd>
    <dt>Repeats</dt>
    <dd>${e.repeat_count}</dd>
    <dt>Cost</dt>
    <dd>${usd(e.cost_usd)}${e.cost_cap_usd !== null ? ` (cap ${usd(e.cost_cap_usd)})` : ""}</dd>
    <dt>Started / finished</dt>
    <dd>${when(e.started_at)} / ${when(e.finished_at)}</dd>
  </dl>`;
}

export function evalPage(e: EvalRow, view: EvalView, runs: readonly RunRow[]): Html {
  let body: Html;
  if (view.kind === "suite") {
    const s = view.summary;
    body = html`<p class="muted">
        Roles:
        ${Object.entries(s.roles)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}
        · ${s.repeatsDone}/${s.repeatsPlanned} repeat(s)
      </p>
      <table>
        <tr>
          <th>Metric</th>
          <th>Mean ± stdev</th>
        </tr>
        ${METRICS.map(
          ([k, label, unit]) =>
            html`<tr>
              <td>${label}</td>
              <td>${statText(s.metrics[k], unit)}</td>
            </tr>`,
        )}
      </table>
      <h2>Tasks (outcome per repeat; ✗ = incorrect)</h2>
      <table>
        <tr>
          <th>Task</th>
          <th>Outcomes</th>
        </tr>
        ${Object.entries(s.tasks).map(
          ([t, o]) =>
            html`<tr>
              <td>${t}</td>
              <td>${o.join(" · ")}</td>
            </tr>`,
        )}
      </table>`;
  } else if (view.kind === "markdown") {
    body = html`<pre>${view.text}</pre>`;
  } else {
    body = html`<p class="muted">Summary not available: ${view.problem}</p>`;
  }
  return layout(
    `Eval ${e.id}`,
    html`<h1>Eval ${e.id}</h1>
      ${evalHeader(e)} ${body}
      <h2>Runs</h2>
      <table>
        <tr>
          <th>Run</th>
          <th>Task</th>
          <th>Repeat</th>
          <th>Status</th>
          <th>First pass</th>
          <th>Cost</th>
        </tr>
        ${runs.map(
          (r) =>
            html`<tr>
              <td><a href="/runs/${r.id}">${r.id}</a></td>
              <td>${r.task_id}</td>
              <td>${r.eval_repeat ?? ""}</td>
              <td>${status(r.status)}</td>
              <td>${r.first_pass === null ? "—" : r.first_pass ? "yes" : "no"}</td>
              <td>${usd(r.cost_usd)}</td>
            </tr>`,
        )}
      </table>`,
  );
}

export function comparePage(
  a: EvalRow,
  b: EvalRow,
  views: { a: EvalView; b: EvalView },
  refusal: string | null,
): Html {
  const title = `${a.id} vs ${b.id}`;
  if (refusal) {
    return layout(
      title,
      html`<h1>Compare</h1>
        <p class="bad">Not comparable: ${refusal}.</p>
        <p>Only evals run against the same baseline commit of the same project are compared.</p>
        <p><a href="/evals${query({})}">Back to evals</a></p>`,
    );
  }
  if (views.a.kind !== "suite" || views.b.kind !== "suite") {
    return layout(
      title,
      html`<h1>Compare</h1>
        <p class="bad">Both evals need a suite summary (summary.json).</p>`,
    );
  }
  const sa = views.a.summary;
  const sb = views.b.summary;
  const tasks = [...new Set([...Object.keys(sa.tasks), ...Object.keys(sb.tasks)])].sort();
  return layout(
    title,
    html`<h1>Compare</h1>
      <p class="muted">
        Baseline <code>${a.baseline_commit.slice(0, 12)}</code> · project ${a.project_id}
      </p>
      <table>
        <tr>
          <th>Metric</th>
          <th><a href="/evals/${a.id}">${a.id}</a></th>
          <th><a href="/evals/${b.id}">${b.id}</a></th>
          <th>Δ (B − A)</th>
        </tr>
        ${METRICS.map(([k, label, unit]) => {
          const ma = sa.metrics[k].mean;
          const mb = sb.metrics[k].mean;
          const delta = ma === null || mb === null ? null : mb - ma;
          return html`<tr>
            <td>${label}</td>
            <td>${statText(sa.metrics[k], unit)}</td>
            <td>${statText(sb.metrics[k], unit)}</td>
            <td>${delta === null ? "n/a" : `${delta >= 0 ? "+" : ""}${fmt(delta, unit)}`}</td>
          </tr>`;
        })}
      </table>
      <p class="muted">
        Roles A:
        ${Object.entries(sa.roles)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}
        · Roles B:
        ${Object.entries(sb.roles)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}
      </p>
      <h2>Tasks</h2>
      <table>
        <tr>
          <th>Task</th>
          <th>A</th>
          <th>B</th>
        </tr>
        ${tasks.map(
          (t) =>
            html`<tr>
              <td>${t}</td>
              <td>${(sa.tasks[t] ?? []).join(" · ")}</td>
              <td>${(sb.tasks[t] ?? []).join(" · ")}</td>
            </tr>`,
        )}
      </table>`,
  );
}

export function notFoundPage(what: string): Html {
  return layout(
    "Not found",
    html`<h1>Not found</h1>
      <p>${what}</p>
      <p><a href="/">Runs</a></p>`,
  );
}
