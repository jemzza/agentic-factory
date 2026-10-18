import { z } from "zod";

/*
 * The GitHub REST objects the factory reads, as Zod schemas over the fields it uses (other
 * fields are allowed and ignored). Shapes follow the REST API reference
 * (docs.github.com/en/rest: issues, issue comments, pulls, labels; API version 2022-11-28).
 * Everything GitHub returns is untrusted input: it is parsed here or rejected.
 */

const User = z.looseObject({ login: z.string(), type: z.string() });

export const IssueSchema = z.looseObject({
  id: z.number().int(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  user: User,
  labels: z.array(z.looseObject({ name: z.string() })),
  created_at: z.string(),
  updated_at: z.string(),
  html_url: z.string(),
  /** Present when the "issue" is a pull request. */
  pull_request: z.unknown().optional(),
});
export type Issue = z.infer<typeof IssueSchema>;

export const CommentSchema = z.looseObject({
  id: z.number().int(),
  body: z.string(),
  user: User,
  created_at: z.string(),
  updated_at: z.string(),
  /** `.../repos/{owner}/{repo}/issues/{number}`: the issue or PR the comment belongs to. */
  issue_url: z.string(),
  html_url: z.string(),
});
export type Comment = z.infer<typeof CommentSchema>;

export const PullSchema = z.looseObject({
  id: z.number().int(),
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable(),
  merge_commit_sha: z.string().nullable(),
  html_url: z.string(),
  head: z.looseObject({ ref: z.string(), sha: z.string() }),
  base: z.looseObject({ ref: z.string() }),
});
export type Pull = z.infer<typeof PullSchema>;

/** Number of the issue or PR a comment belongs to (from its issue_url). */
export function commentTarget(c: Comment): number | null {
  const m = /\/issues\/(\d+)$/.exec(c.issue_url);
  return m?.[1] ? Number(m[1]) : null;
}

/** Rate-limit state from the last response (x-ratelimit-* / retry-after headers). */
export interface RateInfo {
  remaining: number | null;
  limit: number | null;
  /** Epoch seconds when the window resets. */
  resetAt: number | null;
  /** Seconds to wait before the next request (secondary limits), if GitHub said so. */
  retryAfter: number | null;
}

/** An expected failure of a GitHub call: a value, never an exception. */
export type GhError =
  | { kind: "http"; status: number; message: string; rate: RateInfo }
  | { kind: "rate_limited"; waitSeconds: number; rate: RateInfo }
  | { kind: "process"; message: string };

export type GhResult<T> = { ok: true; value: T } | { ok: false; error: GhError };

/**
 * What the factory does on GitHub. One implementation runs `gh api` (gh-cli.ts); tests use the
 * same implementation against a fake `gh` executable.
 */
export interface GitHubApi {
  /** Issues with `label`, any state, updated since `since` (ISO), oldest update first. */
  listIssues(repo: string, label: string, since: string | null): Promise<GhResult<Issue[]>>;
  /** All issue and PR conversation comments updated since `since`, oldest first. */
  listComments(repo: string, since: string | null): Promise<GhResult<Comment[]>>;
  getIssue(repo: string, n: number): Promise<GhResult<Issue>>;
  /** Comments of one issue or PR, oldest first. */
  listIssueComments(repo: string, n: number): Promise<GhResult<Comment[]>>;
  createComment(repo: string, n: number, body: string): Promise<GhResult<Comment>>;
  addLabels(repo: string, n: number, labels: string[]): Promise<GhResult<null>>;
  removeLabel(repo: string, n: number, label: string): Promise<GhResult<null>>;
  setIssueState(repo: string, n: number, state: "open" | "closed"): Promise<GhResult<null>>;
  /** An existing PR for `head` (a branch of this repo), open or closed. */
  findPull(repo: string, head: string): Promise<GhResult<Pull | null>>;
  createPull(
    repo: string,
    p: { title: string; head: string; base: string; body: string },
  ): Promise<GhResult<Pull>>;
  getPull(repo: string, n: number): Promise<GhResult<Pull>>;
  closePull(repo: string, n: number): Promise<GhResult<null>>;
  /** Creates the label if it does not exist yet. */
  ensureLabel(repo: string, name: string, color: string): Promise<GhResult<null>>;
  /** Rate-limit state after the last call. */
  rate(): RateInfo;
}
