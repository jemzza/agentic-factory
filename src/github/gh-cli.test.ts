import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../store/db.js";
import { Store } from "../store/store.js";
import { nextPollDelaySeconds, runDaemon, WATCH_LOCK } from "./daemon.js";
import { GhCli, parseIncludeOutput, rateFromHeaders, rateLimitWait } from "./gh-cli.js";
import type { Watcher } from "./watch.js";

const FAKE_GH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "fake-gh.mjs",
);
let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "gh-cli-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// Recorded with gh 2.102.0 (invalid token, 2026-10-18), headers shortened.
const RECORDED_401 = [
  "HTTP/2.0 401 Unauthorized",
  "Content-Type: application/json; charset=utf-8",
  "X-Github-Media-Type: github.v3; format=json",
  "",
  "{",
  '  "message": "Bad credentials",',
  '  "documentation_url": "https://docs.github.com/rest",',
  '  "status": "401"',
  "}",
].join("\n");

describe("gh api -i output", () => {
  it("parses status, lower-cased headers and the JSON body (recorded 401)", () => {
    expect(parseIncludeOutput(RECORDED_401)).toEqual({
      status: 401,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-github-media-type": "github.v3; format=json",
      },
      body: {
        message: "Bad credentials",
        documentation_url: "https://docs.github.com/rest",
        status: "401",
      },
    });
    expect(parseIncludeOutput("not http")).toBeNull();
  });

  it("follows GitHub's rate-limit rules", () => {
    const r = rateFromHeaders({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-reset": "1000",
      "retry-after": "30",
    });
    expect(r).toEqual({ remaining: 0, limit: 5000, resetAt: 1000, retryAfter: 30 });
    expect(rateLimitWait(403, r, 900)).toBe(30);
    expect(rateLimitWait(403, { ...r, retryAfter: null }, 900)).toBe(100);
    expect(
      rateLimitWait(429, { remaining: 10, limit: 5000, resetAt: null, retryAfter: null }, 900),
    ).toBe(60);
    expect(
      rateLimitWait(403, { remaining: 10, limit: 5000, resetAt: null, retryAfter: null }, 900),
    ).toBeNull();
    expect(rateLimitWait(404, r, 900)).toBeNull();
  });

  it("slows polling down when the primary limit runs low", () => {
    const base = { remaining: 4000, limit: 5000, resetAt: 2000, retryAfter: null };
    expect(nextPollDelaySeconds(60, base, 1000)).toBe(60);
    expect(nextPollDelaySeconds(60, { ...base, remaining: 100 }, 1000)).toBe(1000);
    expect(nextPollDelaySeconds(60, { ...base, retryAfter: 120 }, 1000)).toBe(120);
  });
});

describe("GhCli (fake gh)", () => {
  async function client(state: object) {
    const file = path.join(tmp, `state-${Math.random()}.json`);
    await writeFile(
      file,
      JSON.stringify({
        issues: [],
        comments: [],
        pulls: [],
        expectedToken: "tok-SECRET-1",
        ...state,
      }),
    );
    return new GhCli({
      token: "tok-SECRET-1",
      bin: process.execPath,
      binArgs: [FAKE_GH],
      extraEnv: { FAKE_GH_STATE: file },
    });
  }

  it("passes nothing from the host environment but PATH", async () => {
    process.env["FACTORY_HOST_SECRET"] = "host-secret";
    const env = (await client({})).env();
    delete process.env["FACTORY_HOST_SECRET"];
    expect(Object.keys(env).sort()).toEqual([
      "FAKE_GH_STATE",
      "GH_CONFIG_DIR",
      "GH_NO_UPDATE_NOTIFIER",
      "GH_PROMPT_DISABLED",
      "GH_TOKEN",
      "NO_COLOR",
      "PATH",
    ]);
    expect(env["GH_CONFIG_DIR"]).toContain("factory-gh-config-");
  });

  it("returns HTTP errors as values, with the token masked, and rate limits with a wait", async () => {
    const gh = await client({ failNext: { status: 500, message: "boom tok-SECRET-1" } });
    const res = await gh.getIssue("o/r", 1);
    expect(res).toMatchObject({
      ok: false,
      error: { kind: "http", status: 500, message: "boom ***" },
    });
    const limited = await client({
      failNext: { status: 429, message: "slow down", headers: { "Retry-After": "42" } },
    });
    expect(await limited.listComments("o/r", null)).toMatchObject({
      ok: false,
      error: { kind: "rate_limited", waitSeconds: 42 },
    });
  });

  it("pages through results and rejects malformed items", async () => {
    const comments = Array.from({ length: 150 }, (_, i) => ({
      id: i + 1,
      body: `c${i}`,
      user: { login: "u", type: "User" },
      created_at: `2026-10-20T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
      updated_at: `2026-10-20T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
      issue_url: "https://api.github.com/repos/o/r/issues/1",
      html_url: "x",
    }));
    const gh = await client({ comments });
    const res = await gh.listComments("o/r", null);
    expect(res.ok && res.value.length).toBe(150);
    const bad = await client({ comments: [{ id: "x" }] });
    expect(await bad.listComments("o/r", null)).toMatchObject({
      ok: false,
      error: { kind: "process" },
    });
  });
});

describe("runDaemon", () => {
  it("allows one instance per database and resumes interrupted runs first", async () => {
    const store = new Store(openDb(path.join(tmp, "lock.db")));
    const calls: string[] = [];
    const watcher = {
      resumeInterrupted: () => {
        calls.push("resume");
        return Promise.resolve();
      },
      pollOnce: () => {
        calls.push("poll");
        return Promise.resolve({ issues: 0, comments: 0, executed: 0, ignored: 0, errors: [] });
      },
      drain: () => Promise.resolve(),
    } as unknown as Watcher;
    const opts = {
      store,
      watcher,
      rate: () => ({ remaining: null, limit: null, resetAt: null, retryAfter: null }),
      intervalSeconds: 60,
      once: true,
      log: () => undefined,
      stopRequested: () => false,
      sleep: () => Promise.resolve(),
    };
    // Another live process holds the lock (this test process's parent stands in for it).
    expect(store.acquireNamedLock(WATCH_LOCK, `${os.hostname()}:${process.ppid}`)).toEqual({
      ok: true,
    });
    await expect(runDaemon(opts)).rejects.toThrow(/already running/);
    store.releaseNamedLock(WATCH_LOCK, `${os.hostname()}:${process.ppid}`);
    expect(await runDaemon(opts)).toMatchObject({ polls: 1 });
    expect(calls).toEqual(["resume", "poll"]);
    // A lock left by a dead process is taken over.
    store.acquireNamedLock(WATCH_LOCK, `${os.hostname()}:999999`);
    expect(await runDaemon(opts)).toMatchObject({ polls: 1 });
    store.db.close();
  });
});
