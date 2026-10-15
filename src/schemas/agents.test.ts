import { describe, expect, it } from "vitest";
import { plannerJsonSchema, reviewerJsonSchema } from "./agents.js";

describe("agent JSON schemas", () => {
  it("omit $schema (Claude Code rejects the draft 2020-12 URI)", () => {
    expect(plannerJsonSchema).not.toHaveProperty("$schema");
    expect(reviewerJsonSchema).not.toHaveProperty("$schema");
  });

  it("require every planner and reviewer field", () => {
    expect(plannerJsonSchema).toMatchObject({
      type: "object",
      required: ["plan", "files_to_change", "risks", "questions"],
      additionalProperties: false,
    });
    expect(reviewerJsonSchema).toMatchObject({
      required: ["verdict", "issues", "criteria_check"],
    });
  });
});
