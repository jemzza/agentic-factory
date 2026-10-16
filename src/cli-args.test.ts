import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli-args.js";

describe("parseCliArgs", () => {
  it("returns help when no command is given", () => {
    expect(parseCliArgs([])).toEqual({ kind: "help" });
  });

  it("parses run <taskId>", () => {
    expect(parseCliArgs(["run", "complete-task"])).toEqual({
      kind: "run",
      taskId: "complete-task",
      autoApproveSpec: false,
    });
    expect(parseCliArgs(["run", "complete-task", "--auto-approve-spec"])).toEqual({
      kind: "run",
      taskId: "complete-task",
      autoApproveSpec: true,
    });
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

  it("parses eval with optional task ids", () => {
    const none = { resume: null, costCapUsd: null };
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
    });
    expect(parseCliArgs(["eval", "--resume", "../runs"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["eval", "--cost-cap", "0"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["eval", "--cost-cap", "abc"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["eval", "--repeat", "0"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["eval", "--repeat"])).toMatchObject({ kind: "invalid" });
    expect(parseCliArgs(["eval", "../x"])).toMatchObject({ kind: "invalid" });
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

  it("rejects unknown commands", () => {
    expect(parseCliArgs(["deploy"])).toMatchObject({ kind: "invalid" });
  });
});
