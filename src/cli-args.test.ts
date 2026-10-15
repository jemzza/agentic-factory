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
    expect(parseCliArgs(["eval", "x"])).toMatchObject({ kind: "invalid" });
  });

  it("parses eval", () => {
    expect(parseCliArgs(["eval"])).toEqual({ kind: "eval" });
  });

  it("rejects unknown commands", () => {
    expect(parseCliArgs(["deploy"])).toMatchObject({ kind: "invalid" });
  });
});
