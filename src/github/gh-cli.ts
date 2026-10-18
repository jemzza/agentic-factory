import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import { runCommand } from "../process/run-command.js";
import { createRedactor } from "../store/redact.js";
import {
  CommentSchema,
  IssueSchema,
  PullSchema,
  type GhError,
  type GhResult,
  type GitHubApi,
  type RateInfo,
} from "./api.js";

/*
 * GitHub through the `gh` CLI (verified with gh 2.102.0, `gh api --help`, `gh help environment`):
 *   gh api -i [-X METHOD] [--input -] <path>
 * `-i` prints the status line ("HTTP/2.0 401 Unauthorized"), the response headers, an empty
 * line and the JSON body. An HTTP error exits 1 and prints "gh: <message> (HTTP <status>)" on
 * stderr; the body is still on stdout. Pagination is done here (`page=N` until a page is short),
 * so every request goes through one parser and its rate headers are seen.
 *
 * The token reaches only this process: an explicit env with GH_TOKEN, a factory-owned empty
 * GH_CONFIG_DIR (the owner's own `gh auth login` and keyring are never used), no prompts, no
 * update checks. The token is masked in every error message.
 */

export interface GhCliOptions {
  /** The token value (from .env); never logged. */
  token: string;
  /** Executable and leading args (tests: node + fake-gh.mjs). Default: `gh`. */
  bin?: string;
  binArgs?: string[];
  timeoutMs?: number;
  /** Extra env for the child (tests: the fake's state file). */
  extraEnv?: Record<string, string>;
}

const PER_PAGE = 100;
const MAX_PAGES = 50;

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Parses `gh api -i` stdout; null if it is not a status line + headers + body. */
export function parseIncludeOutput(stdout: string): RawResponse | null {
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\r?\n/.exec(stdout);
  if (!m?.[1]) return null;
  const rest = stdout.slice(m[0].length);
  const sep = /\r?\n\r?\n/.exec(rest);
  const headerText = sep ? rest.slice(0, sep.index) : rest;
  const bodyText = sep ? rest.slice(sep.index + sep[0].length).trim() : "";
  const headers: Record<string, string> = {};
  for (const line of headerText.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let body: unknown = null;
  if (bodyText !== "") {
    try {
      body = JSON.parse(bodyText);
    } catch {
      return null;
    }
  }
  return { status: Number(m[1]), headers, body };
}

export function rateFromHeaders(h: Record<string, string>): RateInfo {
  const num = (k: string) => (h[k] !== undefined && /^\d+$/.test(h[k]) ? Number(h[k]) : null);
  return {
    remaining: num("x-ratelimit-remaining"),
    limit: num("x-ratelimit-limit"),
    resetAt: num("x-ratelimit-reset"),
    retryAfter: num("retry-after"),
  };
}

/**
 * GitHub's documented rule (REST rate limits): on 403/429 wait `retry-after` if present; if
 * x-ratelimit-remaining is 0, wait until x-ratelimit-reset; otherwise wait at least a minute.
 * Returns the wait in seconds, or null if the response is not a rate limit.
 */
export function rateLimitWait(status: number, rate: RateInfo, nowSec: number): number | null {
  if (status !== 403 && status !== 429) return null;
  if (rate.retryAfter !== null) return rate.retryAfter;
  if (rate.remaining === 0 && rate.resetAt !== null) return Math.max(1, rate.resetAt - nowSec);
  return status === 429 ? 60 : null;
}

export class GhCli implements GitHubApi {
  private lastRate: RateInfo = { remaining: null, limit: null, resetAt: null, retryAfter: null };
  private readonly configDir = mkdtempSync(path.join(os.tmpdir(), "factory-gh-config-"));
  private readonly redact: (s: string) => string;

  constructor(private readonly opts: GhCliOptions) {
    this.redact = createRedactor([opts.token]);
  }

  rate(): RateInfo {
    return this.lastRate;
  }

  /** The child's whole environment: nothing else from the host. */
  env(): Record<string, string> {
    return {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      GH_TOKEN: this.opts.token,
      GH_CONFIG_DIR: this.configDir,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
      ...(this.opts.extraEnv ?? {}),
    };
  }

  private async request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    apiPath: string,
    body?: unknown,
  ): Promise<GhResult<RawResponse>> {
    const args = [
      ...(this.opts.binArgs ?? []),
      "api",
      "-i",
      "-X",
      method,
      ...(body === undefined ? [] : ["--input", "-"]),
      apiPath,
    ];
    const proc = await runCommand(this.opts.bin ?? "gh", args, {
      cwd: this.configDir,
      timeoutMs: this.opts.timeoutMs ?? 60_000,
      env: this.env(),
      ...(body === undefined ? {} : { input: JSON.stringify(body) }),
    });
    const fail = (error: GhError): GhResult<RawResponse> => ({ ok: false, error });
    if (proc.spawnError !== undefined) {
      return fail({
        kind: "process",
        message: this.redact(`gh could not start: ${proc.spawnError}`),
      });
    }
    if (proc.timedOut)
      return fail({ kind: "process", message: `gh api ${method} ${apiPath} timed out` });
    const res = parseIncludeOutput(proc.stdout);
    if (!res) {
      return fail({
        kind: "process",
        message: this.redact(
          `gh api ${method} ${apiPath}: unexpected output (exit ${proc.exitCode ?? "null"}): ${proc.stderr.trim()}`,
        ),
      });
    }
    const rate = rateFromHeaders(res.headers);
    this.lastRate = rate;
    if (res.status >= 200 && res.status < 300) return { ok: true, value: res };
    const wait = rateLimitWait(res.status, rate, Math.floor(Date.now() / 1000));
    if (wait !== null) return fail({ kind: "rate_limited", waitSeconds: wait, rate });
    const message =
      typeof res.body === "object" && res.body !== null && "message" in res.body
        ? String(res.body.message)
        : proc.stderr.trim();
    return fail({ kind: "http", status: res.status, message: this.redact(message), rate });
  }

  private async one<S extends z.ZodType>(
    method: "GET" | "POST" | "PATCH",
    apiPath: string,
    schema: S,
    body?: unknown,
  ): Promise<GhResult<z.output<S>>> {
    const res = await this.request(method, apiPath, body);
    if (!res.ok) return res;
    const parsed = schema.safeParse(res.value.body);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          kind: "process",
          message: `${method} ${apiPath}: unexpected response: ${parsed.error.message.slice(0, 300)}`,
        },
      };
    }
    return { ok: true, value: parsed.data };
  }

  private async pages<S extends z.ZodType>(
    apiPath: string,
    schema: S,
  ): Promise<GhResult<z.output<S>[]>> {
    const items: z.output<S>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const sep = apiPath.includes("?") ? "&" : "?";
      const res = await this.request("GET", `${apiPath}${sep}per_page=${PER_PAGE}&page=${page}`);
      if (!res.ok) return res;
      if (!Array.isArray(res.value.body)) {
        return {
          ok: false,
          error: { kind: "process", message: `GET ${apiPath}: expected an array` },
        };
      }
      for (const raw of res.value.body as unknown[]) {
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false,
            error: {
              kind: "process",
              message: `GET ${apiPath}: unexpected item: ${parsed.error.message.slice(0, 300)}`,
            },
          };
        }
        items.push(parsed.data);
      }
      if ((res.value.body as unknown[]).length < PER_PAGE) return { ok: true, value: items };
    }
    return {
      ok: false,
      error: { kind: "process", message: `GET ${apiPath}: more than ${MAX_PAGES} pages` },
    };
  }

  private async noContent(
    method: "POST" | "PATCH" | "DELETE",
    apiPath: string,
    body?: unknown,
    okStatuses: readonly number[] = [],
  ): Promise<GhResult<null>> {
    const res = await this.request(method, apiPath, body);
    if (res.ok) return { ok: true, value: null };
    if (res.error.kind === "http" && okStatuses.includes(res.error.status))
      return { ok: true, value: null };
    return res;
  }

  listIssues(repo: string, label: string, since: string | null) {
    const q = new URLSearchParams({
      labels: label,
      state: "all",
      sort: "updated",
      direction: "asc",
    });
    if (since) q.set("since", since);
    return this.pages(`repos/${repo}/issues?${q.toString()}`, IssueSchema);
  }

  listComments(repo: string, since: string | null) {
    const q = new URLSearchParams({ sort: "updated", direction: "asc" });
    if (since) q.set("since", since);
    return this.pages(`repos/${repo}/issues/comments?${q.toString()}`, CommentSchema);
  }

  getIssue(repo: string, n: number) {
    return this.one("GET", `repos/${repo}/issues/${n}`, IssueSchema);
  }

  listIssueComments(repo: string, n: number) {
    return this.pages(`repos/${repo}/issues/${n}/comments`, CommentSchema);
  }

  createComment(repo: string, n: number, body: string) {
    return this.one("POST", `repos/${repo}/issues/${n}/comments`, CommentSchema, { body });
  }

  addLabels(repo: string, n: number, labels: string[]) {
    return this.noContent("POST", `repos/${repo}/issues/${n}/labels`, { labels });
  }

  /** A label that is not on the issue (404) counts as removed. */
  removeLabel(repo: string, n: number, label: string) {
    return this.noContent(
      "DELETE",
      `repos/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`,
      undefined,
      [404],
    );
  }

  setIssueState(repo: string, n: number, state: "open" | "closed") {
    return this.noContent("PATCH", `repos/${repo}/issues/${n}`, { state });
  }

  async findPull(repo: string, head: string) {
    const owner = repo.split("/")[0] ?? "";
    const q = new URLSearchParams({ head: `${owner}:${head}`, state: "all" });
    const res = await this.pages(`repos/${repo}/pulls?${q.toString()}`, PullSchema);
    return res.ok ? { ok: true as const, value: res.value[0] ?? null } : res;
  }

  createPull(repo: string, p: { title: string; head: string; base: string; body: string }) {
    return this.one("POST", `repos/${repo}/pulls`, PullSchema, p);
  }

  getPull(repo: string, n: number) {
    return this.one("GET", `repos/${repo}/pulls/${n}`, PullSchema);
  }

  closePull(repo: string, n: number) {
    return this.noContent("PATCH", `repos/${repo}/pulls/${n}`, { state: "closed" });
  }

  /** 422 = the label already exists. */
  ensureLabel(repo: string, name: string, color: string) {
    return this.noContent("POST", `repos/${repo}/labels`, { name, color }, [422]);
  }
}
