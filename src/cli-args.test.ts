import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli-args.js";

describe("parseCliArgs", () => {
  it("returns help when no command is given", () => {
    expect(parseCliArgs([])).toEqual({ kind: "help" });
  });

  it("parses run <taskId>, a task file and --project", () => {
    expect(parseCliArgs(["run", "complete-task"])).toEqual({
      kind: "run",
      projectId: null,
      task: "complete-task",
      autoApproveSpec: false,
    });
    expect(parseCliArgs(["run", "complete-task", "--auto-approve-spec"])).toEqual({
      kind: "run",
      projectId: null,
      task: "complete-task",
      autoApproveSpec: true,
    });
    expect(parseCliArgs(["run", "--project", "ledgerlite", "tasks/balance.yaml"])).toEqual({
      kind: "run",
      projectId: "ledgerlite",
      task: "tasks/balance.yaml",
      autoApproveSpec: false,
    });
    expect(parseCliArgs(["run", "--project", "Bad_Id", "x"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["run", "--project"])).toMatchObject({ kind: "invalid" });
  });

  it("rejects run without a taskId", () => {
    expect(parseCliArgs(["run"])).toMatchObject({ kind: "invalid" });
  });

  it("rejects taskIds that could escape the tasks directory", () => {
    expect(parseCliArgs(["run", "../hidden/x"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["run", "Complete_Task"])).toMatchObject({ kind: "invalid" });
  });

  it("rejects extra arguments", () => {
    expect(parseCliArgs(["run", "a", "b"])).toMatchObject({ kind: "invalid" });
  });

  it("parses --concurrency for eval and watch (1 to 8)", () => {
    expect(parseCliArgs(["eval", "--concurrency", "4"])).toMatchObject({
      kind: "eval",
      concurrency: 4,
    });
    expect(parseCliArgs(["eval", "--concurrency", "0"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["eval", "--concurrency", "9"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["watch", "--concurrency", "2"])).toMatchObject({
      kind: "watch",
      concurrency: 2,
    });
    expect(parseCliArgs(["watch"])).toMatchObject({ kind: "watch", concurrency: 1, once: false });
  });

  it("parses eval with optional task ids", () => {
    const none = { resume: null, costCapUsd: null, concurrency: 1 };
    expect(parseCliArgs(["eval"])).toEqual({ kind: "eval", taskIds: [], repeat: 1, ...none });
    expect(parseCliArgs(["eval", "a-task", "b", "a-task"])).toEqual({
      kind: "eval",
      taskIds: ["a-task", "b"],
      repeat: 1,
      ...none,
    });
    expect(parseCliArgs(["eval", "--repeat", "3"])).toEqual({
      kind: "eval",
      taskIds: [],
      repeat: 3,
      ...none,
    });
    expect(
      parseCliArgs([
        "eval",
        "--resume",
        "eval-20261016-113113",
        "--repeat",
        "3",
        "--cost-cap",
        "21",
      ]),
    ).toEqual({
      kind: "eval",
      taskIds: [],
      repeat: 3,
      resume: "eval-20261016-113113",
      costCapUsd: 21,
      concurrency: 1,
    });
    expect(parseCliArgs(["eval", "--resume", "../runs"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["eval", "--cost-cap", "0"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["eval", "--cost-cap", "abc"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["eval", "--repeat", "0"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["eval", "--repeat"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["eval", "../x"])).toMatchObject({ kind: "invalid" });
  });

  it("parses eval-rescore with exactly one eval id", () => {
    expect(parseCliArgs(["eval-rescore", "eval-20261017-095351"])).toEqual({
      kind: "eval-rescore",
      evalId: "eval-20261017-095351",
    });
    expect(parseCliArgs(["eval-rescore"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["eval-rescore", "../x"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["eval-rescore", "eval-20261017-095351", "x"])).toMatchObject({
      kind: "invalid",
    });
  });

  it("parses verify-hidden with and without a taskId", () => {
    expect(parseCliArgs(["verify-hidden"])).toEqual({ kind: "verify-hidden", taskId: null });
    expect(parseCliArgs(["verify-hidden", "pagination"])).toEqual({
      kind: "verify-hidden",
      taskId: "pagination",
    });
    expect(parseCliArgs(["verify-hidden", "../x"])).toMatchObject({ kind: "invalid" });
  });

  it("parses runs and db-import", () => {
    expect(parseCliArgs(["runs"])).toEqual({ kind: "runs", limit: 20 });
    expect(parseCliArgs(["runs", "5"])).toEqual({ kind: "runs", limit: 5 });
    expect(parseCliArgs(["runs", "x"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["db-import"])).toEqual({ kind: "db-import" });
  });

  it("parses approve and reject for the spec gate", () => {
    const id = "20261015-171000-ab12";
    expect(parseCliArgs(["approve", id, "spec"])).toEqual({
      kind: "decide",
      runId: id,
      gate: "spec",
      decision: "approve",
      comment: null,
    });
    expect(parseCliArgs(["reject", id, "spec", "--comment", "split it"])).toEqual({
      kind: "decide",
      runId: id,
      gate: "spec",
      decision: "reject",
      comment: "split it",
    });
    expect(parseCliArgs(["reject", id, "spec"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["approve", id, "merge"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["approve", "bad-id", "spec"])).toMatchObject({ kind: "invalid" });
  });

  it("parses merge, close and baseline-update", () => {
    const id = "20261015-171000-ab12";
    expect(parseCliArgs(["merge", id])).toEqual({
      kind: "decide",
      runId: id,
      gate: "merge",
      decision: "merge",
      comment: null,
    });
    expect(parseCliArgs(["close", id, "--comment", "dup"])).toMatchObject({
      decision: "close",
      comment: "dup",
    });
    expect(parseCliArgs(["close", id])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["baseline-update", "--reason", "new fixture"])).toEqual({
      kind: "baseline-update",
      reason: "new fixture",
    });
    expect(parseCliArgs(["baseline-update"])).toMatchObject({ kind: "invalid" });
  });

  it("parses resume <runId>", () => {
    expect(parseCliArgs(["resume", "20261015-171000-ab12"])).toEqual({
      kind: "resume",
      runId: "20261015-171000-ab12",
    });
    expect(parseCliArgs(["resume"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["resume", "../x"])).toMatchObject({ kind: "invalid" });
  });

  it("parses eval-memory: run (default 2 repeats), verify, freeze", () => {
    expect(parseCliArgs(["eval-memory"])).toEqual({
      kind: "eval-memory",
      action: "run",
      repeat: 2,
      costCapUsd: null,
    });
    expect(parseCliArgs(["eval-memory", "--repeat", "1", "--cost-cap", "20"])).toMatchObject({
      action: "run",
      repeat: 1,
      costCapUsd: 20,
    });
    expect(parseCliArgs(["eval-memory", "verify"])).toMatchObject({ action: "verify" });
    expect(parseCliArgs(["eval-memory", "freeze"])).toMatchObject({ action: "freeze" });
    expect(parseCliArgs(["eval-memory", "--repeat", "9"])).toMatchObject({ kind: "invalid" });
  });

  it("parses dashboard with an optional --port", () => {
    expect(parseCliArgs(["dashboard"])).toEqual({ kind: "dashboard", port: 4317 });
    expect(parseCliArgs(["dashboard", "--port", "8080"])).toEqual({
      kind: "dashboard",
      port: 8080,
    });
    expect(parseCliArgs(["dashboard", "--port", "80"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["dashboard", "--host", "0.0.0.0"])).toMatchObject({ kind: "invalid" });
  });

  it("parses provider-check openai|ollama", () => {
    expect(parseCliArgs(["provider-check", "openai"])).toEqual({
      kind: "provider-check",
      provider: "openai",
    });
    expect(parseCliArgs(["provider-check", "ollama"])).toEqual({
      kind: "provider-check",
      provider: "ollama",
    });
    expect(parseCliArgs(["provider-check"])).toMatchObject({ kind: "invalid" });
  });

  it("rejects unknown commands", () => {
    expect(parseCliArgs(["deploy"])).toMatchObject({ kind: "invalid" });
  });
});
