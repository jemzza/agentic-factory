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
      required: ["plan", "files_to_change", "risks", "questions", "spec", "lessons"],
      additionalProperties: false,
    });
    expect(reviewerJsonSchema).toMatchObject({
      required: ["verdict", "issues", "criteria_check"],
    });
  });
});

describe("the planner's agent schema", () => {
  it("offers every field the factory reads from a planner answer (lessons included)", async () => {
    const { PlannerOutputSchema } = await import("./agents.js");
    const agentFields = Object.keys(
      (plannerJsonSchema as { properties: Record<string, unknown> }).properties,
    ).sort();
    const factoryFields = Object.keys(PlannerOutputSchema.shape).sort();
    expect(agentFields).toEqual(factoryFields);
    expect(agentFields).toContain("lessons");
  });
});
