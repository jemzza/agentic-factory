import {
  loadRunResult,
  makeRunId,
  resumeRun,
  runTask,
  type RunOutcome,
  type RunTaskDeps,
} from "../pipeline/run-task.js";
import { withRepoLock } from "../git/repo-lock.js";
import type { CostPool } from "../pipeline/cost-pool.js";
import type { ProjectEntry } from "../schemas/project.js";
import type { TaskFile } from "../schemas/task.js";
import type { RunRow, Store, StoredRunStatus } from "../store/store.js";
import { commentTarget, type Comment, type GhResult, type GitHubApi, type Issue } from "./api.js";
import {
  isAllowed,
  isFactoryComment,
  parseCommand,
  specCommandApplies,
  type Command,
} from "./commands.js";
import { taskFromIssue } from "./issue-form.js";
import type { RemoteGit } from "./remote.js";
import {
  invalidIssueComment,
  LABEL_COLORS,
  LABELS,
  prBody,
  questionsComment,
  replyComment,
  specComment,
  specHash,
  STATUS_LABELS,
  statusComment,
} from "./render.js";

/*
 * `npm run factory:watch`: GitHub is the interface, the graph is unchanged.
 *
 * Every poll, per project with a GitHub repo:
 *   1. finish decisions whose effect was cut short (a crash between recording a command and
 *      resuming its run): each is recorded once in github_events and applied once;
 *   2. issues with the `factory` label → a task (Zod), or an error comment; authors outside
 *      allowed_users are ignored and logged, nothing of theirs reaches an agent;
 *   3. comments → commands (/approve, /reject, /merge, /close, /retry) from allowed users
 *      only; factory comments (BOT_MARKER) are never commands; every comment id is decided
 *      exactly once, so a restart or an edit never executes a command twice;
 *   4. open factory PRs merged by hand on GitHub → run status merged_externally.
 * Run results are published back: spec comment (version + hash), PR with the report, status
 * labels and comments. Publishing is idempotent (spec versions and PR numbers are in the DB).
 */

export interface WatchDeps {
  api: GitHubApi;
  remote: RemoteGit;
  store: Store;
  projects: readonly ProjectEntry[];
  /** Everything runTask/resumeRun needs except the project, remote and run context. */
  runDeps: (project: ProjectEntry) => Omit<RunTaskDeps, "project" | "remote" | "runContext">;
  /** Label that marks factory issues. */
  label?: string;
  now?: () => Date;
  log?: (m: string) => void;
  /** Set to stop between events (Ctrl+C): nothing new starts. */
  shouldStop?: () => boolean;
  /** Runs driven at the same time (default 1: each run to its next pause before polling on). */
  concurrency?: number;
  /** Spending cap shared by all runs of this process (default: none). */
  costPool?: CostPool;
  /** First pause after an infra_error, doubled each time up to 8x (default 15 min). */
  infraPauseMinutes?: number;
}

export interface PollSummary {
  issues: number;
  comments: number;
  executed: number;
  ignored: number;
  errors: string[];
}

const FAILED_STATUSES: readonly StoredRunStatus[] = [
  "gate_failed",
  "review_rejected",
  "budget_exceeded",
  "error",
  "timeout",
];

class GhCallError extends Error {}

/** A GitHub project's target branch: its git source ref (enforced by the registry schema). */
function targetBranch(p: ProjectEntry): string {
  if (p.source.kind !== "git")
    throw new Error(`project ${p.id}: a GitHub project needs a git source`);
  return p.source.ref;
}

function unwrap<T>(r: GhResult<T>, what: string): T {
  if (r.ok) return r.value;
  const e = r.error;
  throw new GhCallError(
    `${what}: ${e.kind === "http" ? `HTTP ${e.status} ${e.message}` : e.kind === "rate_limited" ? `rate limited (wait ${e.waitSeconds}s)` : e.message}`,
  );
}

export class Watcher {
  private readonly label: string;
  private readonly log: (m: string) => void;
  private readonly now: () => Date;
  private labelsEnsured = new Set<string>();
  /** Runs in flight (concurrency > 1), and the issues they belong to. */
  private readonly inFlight = new Set<Promise<void>>();
  private readonly busyIssues = new Set<string>();
  /** After an infra_error: nothing new starts and running runs pause until then. */
  private pausedUntil = 0;
  private pauses = 0;

  constructor(private readonly deps: WatchDeps) {
    this.label = deps.label ?? LABELS.trigger;
    this.log = deps.log ?? (() => undefined);
    this.now = deps.now ?? (() => new Date());
  }

  private stopping(): boolean {
    return this.deps.shouldStop?.() ?? false;
  }

  /** Why runs should stop at their next node, if they should (Ctrl+C or an infra pause). */
  pauseReason(): string | null {
    if (this.stopping()) return "factory:watch is stopping (Ctrl+C)";
    if (this.infraPaused()) {
      return `infrastructure unavailable; paused until ${new Date(this.pausedUntil).toISOString()}`;
    }
    return null;
  }

  private infraPaused(): boolean {
    return this.now().getTime() < this.pausedUntil;
  }

  /** Starts work on an issue now (concurrency 1) or in the pool, waiting for a free slot. */
  private async schedule(projectId: string, issue: number, fn: () => Promise<void>): Promise<void> {
    const key = `${projectId}#${issue}`;
    const concurrency = Math.max(1, this.deps.concurrency ?? 1);
    if (concurrency === 1) return fn();
    while (this.inFlight.size >= concurrency) await Promise.race(this.inFlight);
    this.busyIssues.add(key);
    const p: Promise<void> = fn()
      .catch((err: unknown) => {
        this.log(
          `[${projectId}] issue #${issue}: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.inFlight.delete(p);
        this.busyIssues.delete(key);
      });
    this.inFlight.add(p);
  }

  private busy(projectId: string, n: number): boolean {
    if (this.busyIssues.has(`${projectId}#${n}`)) return true;
    const run = this.deps.store.runForPull(projectId, n);
    return run?.issue_number != null && this.busyIssues.has(`${projectId}#${run.issue_number}`);
  }

  /** Waits for every run in flight to finish or pause (Ctrl+C, end of a test). */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** After an infra_error: pause (15 min, doubling up to 8x) and retry the task afterwards. */
  private startInfraPause(): Date {
    const minutes = (this.deps.infraPauseMinutes ?? 15) * 2 ** Math.min(this.pauses, 3);
    this.pauses++;
    this.pausedUntil = Math.max(this.pausedUntil, this.now().getTime() + minutes * 60_000);
    return new Date(this.pausedUntil);
  }

  private githubProjects(): (ProjectEntry & { github: { repo: string } })[] {
    return this.deps.projects.filter(
      (p): p is ProjectEntry & { github: { repo: string } } => p.github !== null,
    );
  }

  private runDeps(project: ProjectEntry, issueNumber?: number): RunTaskDeps {
    return {
      ...this.deps.runDeps(project),
      project: { id: project.id, source: project.source },
      remote: this.deps.remote,
      pauseReason: () => this.pauseReason(),
      ...(this.deps.costPool ? { costPool: this.deps.costPool } : {}),
      ...(issueNumber !== undefined
        ? { runContext: { mode: "interactive" as const, issueNumber } }
        : {}),
      specApprovalMode: "manual",
    };
  }

  /** At start: runs a dead process left mid-node continue from their checkpoints. */
  async resumeInterrupted(): Promise<void> {
    for (const project of this.githubProjects()) {
      for (const run of this.deps.store.listGithubRuns(project.id, ["running"])) {
        this.log(
          `[${project.id}] resuming interrupted run ${run.id} (issue #${run.issue_number ?? "?"})`,
        );
        try {
          const res = await resumeRun(run.id, this.runDeps(project));
          if (res.kind === "resumed") await this.publish(project, run.id, res.outcome);
        } catch (err) {
          this.log(
            `[${project.id}] could not resume ${run.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  async pollOnce(): Promise<PollSummary> {
    const summary: PollSummary = { issues: 0, comments: 0, executed: 0, ignored: 0, errors: [] };
    for (const project of this.githubProjects()) {
      if (this.stopping()) break;
      try {
        await this.pollProject(project, summary);
      } catch (err) {
        const m = `[${project.id}] ${err instanceof Error ? err.message : String(err)}`;
        summary.errors.push(m);
        this.log(`poll error: ${m}`);
      }
    }
    return summary;
  }

  private async ensureLabels(repo: string): Promise<void> {
    if (this.labelsEnsured.has(repo)) return;
    for (const [name, color] of Object.entries(LABEL_COLORS)) {
      unwrap(await this.deps.api.ensureLabel(repo, name, color), `label ${name}`);
    }
    this.labelsEnsured.add(repo);
  }

  private async pollProject(
    project: ProjectEntry & { github: { repo: string } },
    summary: PollSummary,
  ): Promise<void> {
    const { store, api } = this.deps;
    const repo = project.github.repo;
    await this.ensureLabels(repo);
    if (this.infraPaused()) {
      // Nothing new starts during an infra pause; issues and comments wait (cursors unchanged).
      await this.checkExternalMerges(project);
      return;
    }
    await this.continueAfterPause(project);
    await this.applyPending(project);

    // Issues. `since` is inclusive; already decided issues are skipped by github_events.
    const issueSince = store.getCursor(project.id, "issues");
    const issues = unwrap(await api.listIssues(repo, this.label, issueSince), "list issues");
    let issueCursor = issueSince;
    for (const issue of issues) {
      if (this.stopping()) return;
      if (issue.pull_request === undefined) {
        summary.issues++;
        await this.onIssue(project, issue, summary);
      }
      issueCursor = issue.updated_at;
    }
    if (issueCursor) store.setCursor(project.id, "issues", issueCursor);

    // Comments on issues and PRs.
    const commentSince = store.getCursor(project.id, "comments");
    const comments = unwrap(await api.listComments(repo, commentSince), "list comments");
    let commentCursor = commentSince;
    for (const c of comments) {
      if (this.stopping()) return;
      // A command for a run that is still working waits for the next poll (cursor stays here).
      const target = commentTarget(c);
      if (
        target !== null &&
        this.busy(project.id, target) &&
        !store.getGithubEvent(project.id, "comment", c.id)
      ) {
        break;
      }
      summary.comments++;
      await this.onComment(project, c, summary);
      commentCursor = c.updated_at;
    }
    if (commentCursor) store.setCursor(project.id, "comments", commentCursor);

    await this.checkExternalMerges(project);
    await this.reconcile(project);
  }

  /**
   * Decisions made through the CLI (the backup path) are published too: a run that reached the
   * merge gate without a PR gets one, and a run merged or closed outside the watcher gets its
   * issue closed and labelled — once (recorded as a `pr` event).
   */
  private async reconcile(project: ProjectEntry & { github: { repo: string } }): Promise<void> {
    const { store } = this.deps;
    for (const run of store.listGithubRuns(project.id, ["awaiting_merge_approval"])) {
      if (run.pr_number !== null || !run.report_path) continue;
      const result = await loadRunResult(run.report_path);
      await this.publish(project, run.id, {
        kind: "awaiting",
        gate: "merge",
        runId: run.id,
        noticePath: "",
        result,
      });
    }
    for (const run of store.listGithubRuns(project.id, ["merged", "closed"])) {
      if (run.pr_number === null || !run.report_path) continue;
      if (store.getGithubEvent(project.id, "pr", run.pr_number)) continue;
      await this.publish(project, run.id, {
        kind: "finished",
        ...(await loadRunResult(run.report_path)),
      });
    }
  }

  /** Decisions recorded but not applied (crash between the DB write and the run's resume). */
  private async applyPending(project: ProjectEntry & { github: { repo: string } }): Promise<void> {
    for (const e of this.deps.store.listUnappliedGithubEvents(project.id)) {
      const startsRun =
        e.outcome === "accepted" || e.detail === JSON.stringify({ decision: "retry" });
      if (startsRun && e.number !== null) {
        // A new run for the issue was decided; start it unless it already exists.
        const last = this.deps.store.latestRunForIssue(project.id, e.number);
        if (!last || last.started_at < e.processed_at) {
          const issue = unwrap(
            await this.deps.api.getIssue(project.github.repo, e.number),
            "get issue",
          );
          const parsed = taskFromIssue(issue);
          this.log(
            `[${project.id}] starting the run decided for issue #${e.number} before a restart`,
          );
          if (parsed.ok) await this.startRun(project, issue, parsed.task);
        }
        this.deps.store.markGithubEventApplied(e.id);
        continue;
      }
      if (!e.run_id || !e.detail) continue;
      const run = this.deps.store.getRun(e.run_id);
      const answer = JSON.parse(e.detail) as { decision: string; comment?: string; actor: string };
      if (
        run &&
        (run.status === "awaiting_spec_approval" || run.status === "awaiting_merge_approval")
      ) {
        this.log(`[${project.id}] re-applying recorded ${answer.decision} for ${run.id}`);
        await this.resumeWith(project, run, answer);
      }
      this.deps.store.markGithubEventApplied(e.id);
    }
  }

  private async onIssue(
    project: ProjectEntry & { github: { repo: string } },
    issue: Issue,
    summary: PollSummary,
  ): Promise<void> {
    const { store } = this.deps;
    if (store.getGithubEvent(project.id, "issue", issue.id)) return;
    if (issue.state !== "open") return;
    if (!isAllowed(issue.user.login, project.allowed_users) || issue.user.type !== "User") {
      // Never commented on, never read further: the text of strangers reaches nobody.
      store.recordGithubEvent({
        projectId: project.id,
        kind: "issue",
        githubId: issue.id,
        number: issue.number,
        author: issue.user.login,
        outcome: "ignored_unauthorized",
      });
      summary.ignored++;
      this.log(
        `[${project.id}] issue #${issue.number} by ${issue.user.login}: not an allowed user, ignored`,
      );
      return;
    }
    const parsed = taskFromIssue(issue);
    if (!parsed.ok) {
      unwrap(
        await this.deps.api.createComment(
          project.github.repo,
          issue.number,
          invalidIssueComment(issue.number, parsed.errors),
        ),
        "comment",
      );
      store.recordGithubEvent({
        projectId: project.id,
        kind: "issue",
        githubId: issue.id,
        number: issue.number,
        author: issue.user.login,
        outcome: "invalid",
        detail: parsed.errors.join("; "),
      });
      this.log(
        `[${project.id}] issue #${issue.number}: invalid task (${parsed.errors.length} problem(s))`,
      );
      return;
    }
    store.recordGithubEvent({
      projectId: project.id,
      kind: "issue",
      githubId: issue.id,
      number: issue.number,
      author: issue.user.login,
      outcome: "accepted",
      applied: false,
    });
    await this.startRun(project, issue, parsed.task);
    this.markEventApplied(project.id, "issue", issue.id);
  }

  private withOrigin(
    project: ProjectEntry & { github: { repo: string } },
    issue: Issue,
    task: TaskFile,
  ): TaskFile {
    return {
      ...task,
      origin: {
        kind: "github",
        repo: project.github.repo,
        issue: issue.number,
        url: issue.html_url,
      },
    };
  }

  private async startRun(
    project: ProjectEntry & { github: { repo: string } },
    issue: Issue,
    task: TaskFile,
  ): Promise<void> {
    const repo = project.github.repo;
    await this.setStatusLabel(repo, issue.number, LABELS.inProgress);
    const runId = makeRunId(this.now());
    this.log(`[${project.id}] issue #${issue.number} → run ${runId}`);
    await this.schedule(project.id, issue.number, () => this.drive(project, issue, task, runId));
  }

  private async drive(
    project: ProjectEntry & { github: { repo: string } },
    issue: Issue,
    task: TaskFile,
    runId: string,
  ): Promise<void> {
    const repo = project.github.repo;
    let outcome: RunOutcome;
    try {
      outcome = await runTask(
        this.withOrigin(project, issue, task),
        this.runDeps(project, issue.number),
        { runId },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.comment(
        repo,
        issue.number,
        statusComment(runId, "error", "The factory could not start this task", message),
      );
      await this.setStatusLabel(repo, issue.number, LABELS.failed);
      return;
    }
    await this.publish(project, runId, outcome);
  }

  private async onComment(
    project: ProjectEntry & { github: { repo: string } },
    c: Comment,
    summary: PollSummary,
  ): Promise<void> {
    const { store } = this.deps;
    if (store.getGithubEvent(project.id, "comment", c.id)) return;
    const n = commentTarget(c);
    const record = (
      outcome: Parameters<Store["recordGithubEvent"]>[0]["outcome"],
      extra: { runId?: string; detail?: string; applied?: boolean } = {},
    ) =>
      store.recordGithubEvent({
        projectId: project.id,
        kind: "comment",
        githubId: c.id,
        number: n,
        author: c.user.login,
        outcome,
        ...extra,
      });
    if (isFactoryComment(c.body)) {
      record("factory_comment");
      return;
    }
    if (!isAllowed(c.user.login, project.allowed_users) || c.user.type !== "User") {
      // Logged without its text; never passed on.
      record("ignored_unauthorized");
      if (parseCommand(c.body) !== null) {
        summary.ignored++;
        this.log(
          `[${project.id}] command from ${c.user.login} on #${n ?? "?"} ignored: not an allowed user`,
        );
      }
      return;
    }
    const parsed = parseCommand(c.body);
    if (parsed === null) {
      record("not_command");
      return;
    }
    if (n === null) {
      record("ignored_not_applicable");
      return;
    }
    if (!parsed.ok) {
      record("invalid", { detail: parsed.error });
      await this.comment(
        project.github.repo,
        n,
        replyComment(`comment-${c.id}`, `@${c.user.login} ${parsed.error}`),
      );
      return;
    }
    const done = await this.execute(project, c, n, parsed.command, record);
    if (done) summary.executed++;
    else summary.ignored++;
  }

  /** Runs one command. Returns false if it did not apply (reply posted, nothing changed). */
  private async execute(
    project: ProjectEntry & { github: { repo: string } },
    c: Comment,
    n: number,
    cmd: Command,
    record: (
      o: Parameters<Store["recordGithubEvent"]>[0]["outcome"],
      extra?: { runId?: string; detail?: string; applied?: boolean },
    ) => boolean,
  ): Promise<boolean> {
    const { store } = this.deps;
    const repo = project.github.repo;
    const notApplicable = async (
      why: string,
      outcome: "ignored_stale" | "ignored_not_applicable" = "ignored_not_applicable",
    ) => {
      record(outcome, { detail: why });
      await this.comment(
        repo,
        n,
        replyComment(
          `comment-${c.id}`,
          `@${c.user.login} \`/${cmd.kind}\` was not applied: ${why}.`,
        ),
      );
      return false;
    };

    if (cmd.kind === "retry") {
      const last = store.latestRunForIssue(project.id, n);
      const issueEvent = store
        .listGithubEvents(project.id)
        .find((e) => e.kind === "issue" && e.number === n);
      const retryable = last
        ? last.status === "needs_clarification" ||
          FAILED_STATUSES.includes(last.status) ||
          last.status === "infra_error"
        : issueEvent?.outcome === "invalid";
      if (!retryable)
        return notApplicable(
          last ? `the current run is ${last.status}` : "this issue has no failed or unclear run",
        );
      const issue = unwrap(await this.deps.api.getIssue(repo, n), "get issue");
      const parsed = taskFromIssue(issue);
      if (!parsed.ok) {
        record("invalid", { detail: parsed.errors.join("; ") });
        await this.comment(repo, n, invalidIssueComment(n, parsed.errors));
        return false;
      }
      const clarifications = await this.clarifications(project, n, last);
      const task: TaskFile = clarifications.length
        ? {
            ...parsed.task,
            request: `${parsed.task.request}\n\nClarifications from the issue thread:\n${clarifications.map((x) => `- ${x}`).join("\n")}`,
          }
        : parsed.task;
      record("executed", { detail: JSON.stringify({ decision: "retry" }), applied: false });
      // A manual retry replaces the automatic one after an infra pause.
      if (last) store.deleteWatchRetry(last.id);
      await this.startRun(project, issue, task);
      this.markApplied(project.id, c.id);
      return true;
    }

    if (cmd.kind === "approve" || cmd.kind === "reject") {
      const run = store.latestRunForIssue(project.id, n);
      if (!run || run.status !== "awaiting_spec_approval") {
        return notApplicable(
          run
            ? `the run is ${run.status}, not waiting for a spec decision`
            : "this issue has no run",
        );
      }
      const latest = store.latestSpecVersion(run.id);
      if (!latest) return notApplicable("no specification has been published yet");
      const applies = specCommandApplies(
        c.created_at,
        { publishedAt: latest.published_at, hash: latest.hash },
        cmd.kind === "approve" ? cmd.hash : null,
      );
      if (!applies.ok) return notApplicable(applies.reason, "ignored_stale");
      const answer = {
        decision: cmd.kind,
        actor: c.user.login,
        ...(cmd.kind === "reject" ? { comment: cmd.reason } : {}),
      };
      this.recordDecision(run, "spec", answer, record);
      await this.resumeWith(project, run, answer);
      this.markApplied(project.id, c.id);
      return true;
    }

    // merge / close: on the PR.
    const run = store.runForPull(project.id, n);
    if (!run || run.status !== "awaiting_merge_approval") {
      return notApplicable(
        run
          ? `the run is ${run.status}, not waiting for a merge decision`
          : `#${n} is not a factory pull request`,
      );
    }
    const answer = {
      decision: cmd.kind,
      actor: c.user.login,
      ...(cmd.kind === "close" ? { comment: cmd.reason } : {}),
    };
    this.recordDecision(run, "merge", answer, record);
    await this.resumeWith(project, run, answer);
    this.markApplied(project.id, c.id);
    return true;
  }

  /** The command and its approval row in ONE transaction: decided exactly once. */
  private recordDecision(
    run: RunRow,
    gate: "spec" | "merge",
    answer: { decision: "approve" | "reject" | "merge" | "close"; actor: string; comment?: string },
    record: (
      o: "executed",
      extra?: { runId?: string; detail?: string; applied?: boolean },
    ) => boolean,
  ): void {
    this.deps.store.db.transaction(() => {
      if (!record("executed", { runId: run.id, detail: JSON.stringify(answer), applied: false }))
        return;
      this.deps.store.recordApproval({
        runId: run.id,
        gate,
        decision: answer.decision,
        actor: answer.actor,
        comment: answer.comment ?? null,
        channel: "github",
      });
    })();
  }

  private markApplied(projectId: string, commentId: number): void {
    this.markEventApplied(projectId, "comment", commentId);
  }

  private markEventApplied(projectId: string, kind: "issue" | "comment", githubId: number): void {
    const e = this.deps.store.getGithubEvent(projectId, kind, githubId);
    if (e) this.deps.store.markGithubEventApplied(e.id);
  }

  private async resumeWith(
    project: ProjectEntry & { github: { repo: string } },
    run: RunRow,
    answer: { decision: string; actor: string; comment?: string },
  ): Promise<void> {
    if (run.issue_number !== null && answer.decision === "approve") {
      await this.setStatusLabel(project.github.repo, run.issue_number, LABELS.inProgress);
    }
    await this.schedule(project.id, run.issue_number ?? -1, async () => {
      const res = await resumeRun(run.id, this.runDeps(project), { answer });
      if (res.kind === "resumed") await this.publish(project, run.id, res.outcome);
    });
  }

  /**
   * After an infra pause: runs that paused at a node boundary go on from their checkpoints, and
   * tasks whose run ended infra_error are retried (the intent is in watch_retries).
   */
  private async continueAfterPause(
    project: ProjectEntry & { github: { repo: string } },
  ): Promise<void> {
    const { store } = this.deps;
    for (const run of store.listGithubRuns(project.id, ["running"])) {
      if (!run.status_message.startsWith("paused:") || run.issue_number === null) continue;
      if (this.busy(project.id, run.issue_number) || run.locked_by !== null) continue;
      this.log(`[${project.id}] continuing paused run ${run.id}`);
      await this.schedule(project.id, run.issue_number, async () => {
        const res = await resumeRun(run.id, this.runDeps(project));
        if (res.kind === "resumed") await this.publish(project, run.id, res.outcome);
      });
    }
    for (const r of store.dueWatchRetries(project.id, this.now().toISOString())) {
      if (this.busy(project.id, r.issue_number)) continue;
      store.deleteWatchRetry(r.run_id);
      const issue = unwrap(
        await this.deps.api.getIssue(project.github.repo, r.issue_number),
        "get issue",
      );
      const parsed = taskFromIssue(issue);
      if (!parsed.ok) {
        await this.comment(
          project.github.repo,
          r.issue_number,
          invalidIssueComment(r.issue_number, parsed.errors),
        );
        continue;
      }
      this.log(`[${project.id}] retrying issue #${r.issue_number} after the infra pause`);
      await this.startRun(project, issue, parsed.task);
    }
  }

  /** Allowed users' plain comments on the issue after the run ended (answers to questions). */
  private async clarifications(
    project: ProjectEntry & { github: { repo: string } },
    n: number,
    last: RunRow | null,
  ): Promise<string[]> {
    const all = unwrap(
      await this.deps.api.listIssueComments(project.github.repo, n),
      "issue comments",
    );
    const after = last?.finished_at ?? last?.started_at ?? "";
    return all
      .filter(
        (c) =>
          c.created_at > after &&
          isAllowed(c.user.login, project.allowed_users) &&
          c.user.type === "User",
      )
      .filter((c) => !isFactoryComment(c.body) && parseCommand(c.body) === null)
      .map((c) => c.body.trim().replace(/\s+/g, " ").slice(0, 2000));
  }

  private async checkExternalMerges(
    project: ProjectEntry & { github: { repo: string } },
  ): Promise<void> {
    const repo = project.github.repo;
    for (const run of this.deps.store.listGithubRuns(project.id, ["awaiting_merge_approval"])) {
      if (run.pr_number === null) continue;
      const pr = unwrap(await this.deps.api.getPull(repo, run.pr_number), "get pull");
      if (pr.merged_at === null) continue;
      this.deps.store.updateRun(run.id, {
        status: "merged_externally",
        statusMessage: `PR #${pr.number} was merged on GitHub (${pr.merge_commit_sha ?? "?"}), not by the factory: no merge gate ran`,
      });
      this.log(
        `[${project.id}] PR #${pr.number} merged on GitHub by hand → ${run.id} merged_externally`,
      );
      await this.comment(
        repo,
        pr.number,
        statusComment(
          run.id,
          "merged-externally",
          "Merged outside the factory",
          "This pull request was merged on GitHub directly. The factory's merge gate did not run on the merge result; the run is recorded as `merged_externally`.",
        ),
      );
      if (run.issue_number !== null) await this.setStatusLabel(repo, run.issue_number, LABELS.done);
    }
  }

  // ---- publishing ------------------------------------------------------------------

  private async comment(repo: string, n: number, body: string): Promise<number> {
    return unwrap(await this.deps.api.createComment(repo, n, body), "comment").id;
  }

  /** Exactly one status label (plus the trigger label) on the issue. */
  private async setStatusLabel(repo: string, n: number, label: string | null): Promise<void> {
    const issue = unwrap(await this.deps.api.getIssue(repo, n), "get issue");
    for (const l of issue.labels.map((x) => x.name)) {
      if (STATUS_LABELS.includes(l as (typeof STATUS_LABELS)[number]) && l !== label) {
        unwrap(await this.deps.api.removeLabel(repo, n, l), "remove label");
      }
    }
    if (label && !issue.labels.some((x) => x.name === label)) {
      unwrap(await this.deps.api.addLabels(repo, n, [label]), "add label");
    }
  }

  async publish(
    project: ProjectEntry & { github: { repo: string } },
    runId: string,
    outcome: RunOutcome,
  ): Promise<void> {
    const { store, api } = this.deps;
    const repo = project.github.repo;
    const run = store.requireRun(runId);
    const issue = run.issue_number;
    if (issue === null) return;
    // Paused at a node boundary: the run goes on later from its checkpoint; nothing to show yet.
    if (outcome.kind === "paused") return;

    if (outcome.kind === "awaiting" && outcome.gate === "spec") {
      const files = outcome.spec?.files ?? {};
      const change = outcome.spec?.change;
      const commit = outcome.spec?.commit;
      if (!change || !commit) throw new Error(`run ${runId} is at the spec gate without a spec`);
      const hash = specHash(files);
      const latest = store.latestSpecVersion(runId);
      // Every draft (a spec commit) is a new version, even with identical content: a
      // rejection always needs a fresh /approve. The version is recorded before it is
      // posted (its time bounds valid approvals); a crash in between reposts it.
      const version =
        latest?.spec_commit === commit
          ? latest
          : store.recordSpecVersion({
              runId,
              hash,
              specCommit: commit,
              commentId: null,
              publishedAt: this.now().toISOString(),
            });
      if (version.comment_id === null) {
        const id = await this.comment(
          repo,
          issue,
          specComment({ runId, version: version.version, hash, spec: change }),
        );
        store.setSpecVersionComment(runId, version.version, id);
      }
      await this.setStatusLabel(repo, issue, LABELS.specReview);
      return;
    }

    if (outcome.kind === "awaiting" && outcome.gate === "merge") {
      const report = outcome.result?.report;
      if (!report?.worktree) throw new Error(`run ${runId} is at the merge gate without a report`);
      if (run.pr_number === null) {
        const branch = report.worktree.branch;
        const head = report.worktree.headCommit;
        if (!head) throw new Error(`run ${runId} has no head commit to push`);
        const repoDir = report.target?.repoDir;
        if (!repoDir) throw new Error(`run ${runId} has no repository`);
        const pushed = await withRepoLock(repoDir, () =>
          this.deps.remote.push(repoDir, head, branch),
        );
        if (!pushed.ok) throw new Error(`push ${branch} failed: ${pushed.message}`);
        const existing = unwrap(await api.findPull(repo, branch), "find pull");
        const pr =
          existing ??
          unwrap(
            await api.createPull(repo, {
              title: `${report.task.title} (#${issue})`,
              head: branch,
              base: targetBranch(project),
              body: prBody({
                report,
                issue,
                specHashValue: store.latestSpecVersion(runId)?.hash ?? null,
              }),
            }),
            "create pull",
          );
        store.updateRun(runId, { prNumber: pr.number });
        await this.comment(
          repo,
          issue,
          statusComment(
            runId,
            "pr",
            "Pull request opened",
            `${pr.html_url}\n\nComment \`/merge\` or \`/close <reason>\` on the pull request.`,
          ),
        );
      } else if (outcome.blockedReason) {
        await this.comment(
          repo,
          run.pr_number,
          statusComment(
            runId,
            "merge-blocked",
            "Merge blocked — nothing was merged",
            outcome.blockedReason,
          ),
        );
      }
      await this.setStatusLabel(repo, issue, LABELS.prOpen);
      return;
    }

    // Finished.
    const report = outcome.kind === "finished" ? outcome.report : null;
    const status = store.requireRun(runId).status;
    const pr = store.requireRun(runId).pr_number;
    const finished = (prNumber: number | null) => {
      if (prNumber === null) return;
      store.recordGithubEvent({
        projectId: project.id,
        kind: "pr",
        githubId: prNumber,
        number: prNumber,
        outcome: "executed",
        runId,
      });
    };
    if (status === "merged") {
      if (pr !== null) {
        const pull = unwrap(await api.getPull(repo, pr), "get pull");
        // GitHub marks the PR merged by itself once its head is in the base branch.
        if (pull.state === "open") unwrap(await api.closePull(repo, pr), "close pull");
        await this.comment(
          repo,
          pr,
          statusComment(
            runId,
            "merged",
            "Merged by the factory",
            store.requireRun(runId).status_message,
          ),
        );
      }
      await this.setStatusLabel(repo, issue, LABELS.done);
      unwrap(await api.setIssueState(repo, issue, "closed"), "close issue");
      finished(pr);
      return;
    }
    if (status === "closed") {
      if (pr !== null) unwrap(await api.closePull(repo, pr), "close pull");
      await this.comment(
        repo,
        issue,
        statusComment(
          runId,
          "closed",
          "Closed without merging",
          store.requireRun(runId).status_message,
        ),
      );
      await this.setStatusLabel(repo, issue, LABELS.done);
      unwrap(await api.setIssueState(repo, issue, "closed"), "close issue");
      finished(pr);
      return;
    }
    if (status === "needs_clarification") {
      await this.comment(
        repo,
        issue,
        questionsComment(runId, report?.plan?.questions ?? [], report?.message ?? ""),
      );
      await this.setStatusLabel(repo, issue, LABELS.needsClarification);
      return;
    }
    if (status !== "infra_error") this.pauses = 0;
    if (status === "infra_error") {
      // Not a result of the task: pause everything, then retry it automatically.
      const until = this.startInfraPause();
      store.scheduleWatchRetry({
        runId,
        projectId: project.id,
        issueNumber: issue,
        notBefore: until.toISOString(),
      });
      await this.comment(
        repo,
        issue,
        statusComment(
          runId,
          "paused",
          "Paused: infrastructure unavailable",
          `${report?.message ?? ""}\n\nThis is not a result of the task. The factory pauses and retries this task automatically after ${until.toISOString()} (UTC); runs that paused meanwhile continue from their checkpoints then. You can also comment \`/retry\` later.`,
        ),
      );
      await this.setStatusLabel(repo, issue, LABELS.paused);
      return;
    }
    if (FAILED_STATUSES.includes(status)) {
      await this.comment(
        repo,
        issue,
        statusComment(
          runId,
          "failed",
          `Failed: \`${status}\``,
          `${report?.message ?? store.requireRun(runId).status_message}\n\nComment \`/retry\` to run the task again.`,
        ),
      );
      await this.setStatusLabel(repo, issue, LABELS.failed);
    }
  }
}
