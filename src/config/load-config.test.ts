import { describe, expect, it } from "vitest";
import { FACTORY_ROOT } from "../paths.js";
import { assertOutside, expandHome, loadConfig, resolveConfig } from "./load-config.js";

describe("config", () => {
  it("loads the committed factory.config.json", async () => {
    const config = await loadConfig(undefined, { FACTORY_WORKDIR: "/tmp/af-work" });
    expect(config.workdirAbs).toBe("/tmp/af-work");
    expect(config.roles.developer.runtime).toBe("claude-code");
  });

  it("expands ~", () => {
    expect(expandHome("~/w", "/home/u")).toBe("/home/u/w");
    expect(expandHome("/abs", "/home/u")).toBe("/abs");
  });

  it("refuses a workdir inside or containing the factory repo", () => {
    expect(() => {
      assertOutside(`${FACTORY_ROOT}/work`, FACTORY_ROOT);
    }).toThrow();
    expect(() => {
      assertOutside(FACTORY_ROOT, FACTORY_ROOT);
    }).toThrow();
    expect(() => {
      assertOutside("/", FACTORY_ROOT);
    }).toThrow();
    expect(() => {
      assertOutside("/tmp/af-work", FACTORY_ROOT);
    }).not.toThrow();
  });

  it("validates role bindings: OpenCode is read-only, independent and pinned", () => {
    const base = {
      workdir: "/tmp/af-work",
      roles: {
        planner: { runtime: "claude-code", model: "opus" },
        developer: { runtime: "claude-code", model: "opus" },
        reviewer: { runtime: "opencode", model: "openai/gpt-x-2026", keyEnv: ["OPENAI_API_KEY"] },
      },
      secretEnv: ["OPENAI_API_KEY", "FACTORY_GITHUB_TOKEN"],
      stepTimeoutsMinutes: { planner: 1, developer: 1, reviewer: 1, check: 1 },
      maxDiffCharsForReview: 1000,
      evalCostCapUsd: 1,
    };
    expect(resolveConfig(base).models.reviewer).toBe("openai/gpt-x-2026");
    const withReviewer =
      (reviewer: object, secretEnv = ["OPENAI_API_KEY", "FACTORY_GITHUB_TOKEN"]) =>
      () =>
        resolveConfig({ ...base, secretEnv, roles: { ...base.roles, reviewer } });
    expect(
      withReviewer({ runtime: "opencode", model: "openai/latest", keyEnv: ["OPENAI_API_KEY"] }),
    ).toThrow(/exact model id/);
    expect(
      withReviewer({ runtime: "opencode", model: "opus", keyEnv: ["OPENAI_API_KEY"] }),
    ).toThrow(/provider\/model-id/);
    expect(withReviewer({ runtime: "opencode", model: "openai/gpt-x-2026" })).toThrow(
      /keyEnv must name/,
    );
    expect(
      withReviewer(
        { runtime: "opencode", model: "openai/gpt-x-2026", keyEnv: ["OPENAI_API_KEY"] },
        [],
      ),
    ).toThrow(/must also be listed in secretEnv/);
    expect(() =>
      resolveConfig({
        ...base,
        roles: {
          ...base.roles,
          developer: { runtime: "opencode", model: "openai/x", keyEnv: ["OPENAI_API_KEY"] },
        },
      }),
    ).toThrow(/cannot be the developer/);
  });
});
