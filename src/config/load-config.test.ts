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

  it("validates Pi bindings: read-only, provider/model, keys in secretEnv; a subscription needs none", () => {
    const base = {
      workdir: "/tmp/af-work",
      roles: {
        planner: { runtime: "claude-code", model: "opus" },
        developer: { runtime: "claude-code", model: "opus" },
        reviewer: { runtime: "pi", model: "google/gemini-x-2026", keyEnv: ["GEMINI_API_KEY"] },
      },
      secretEnv: ["GEMINI_API_KEY", "FACTORY_GITHUB_TOKEN"],
      stepTimeoutsMinutes: { planner: 1, developer: 1, reviewer: 1, check: 1 },
      maxDiffCharsForReview: 1000,
      evalCostCapUsd: 1,
    };
    expect(resolveConfig(base).roles.reviewer.runtime).toBe("pi");
    const reviewer =
      (r: object, secretEnv = base.secretEnv) =>
      () =>
        resolveConfig({ ...base, secretEnv, roles: { ...base.roles, reviewer: r } });
    expect(reviewer({ runtime: "pi", model: "github-copilot/gemini-3.8-flash" })).not.toThrow();
    expect(reviewer({ runtime: "pi", model: "gemini" })).toThrow(/"provider\/model-id" for pi/);
    expect(reviewer({ runtime: "pi", model: "google/latest" })).toThrow(/exact model id/);
    expect(
      reviewer({ runtime: "pi", model: "google/g", keyEnv: ["GEMINI_API_KEY"] }, [
        "FACTORY_GITHUB_TOKEN",
      ]),
    ).toThrow(/must also be listed in secretEnv/);
    expect(() =>
      resolveConfig({
        ...base,
        roles: { ...base.roles, developer: { runtime: "pi", model: "google/g" } },
      }),
    ).toThrow(/pi runtime is read-only and cannot be the developer/);
  });

  it("validates the Pi + Ollama reviewer pin and never lets Pi use Claude", () => {
    const pin = {
      baseModel: "qwen2.5-coder:7b-instruct-q4_K_M",
      digest: "dae161e27b0e",
      numCtx: 32768,
      modelfile: "ollama/factory-reviewer-qwen2.5-coder-7b.Modelfile",
    };
    const base = {
      workdir: "/tmp/af-work",
      roles: {
        planner: { runtime: "claude-code", model: "opus" },
        developer: { runtime: "claude-code", model: "opus" },
        reviewer: { runtime: "pi", model: "ollama/factory-reviewer-qwen2.5-coder-7b", ollama: pin },
      },
      secretEnv: ["FACTORY_GITHUB_TOKEN"],
      stepTimeoutsMinutes: { planner: 1, developer: 1, reviewer: 1, check: 1 },
      maxDiffCharsForReview: 1000,
      evalCostCapUsd: 1,
    };
    expect(resolveConfig(base).roles.reviewer.ollama?.url).toBe("http://127.0.0.1:11434");
    const reviewer = (r: object) => () =>
      resolveConfig({ ...base, roles: { ...base.roles, reviewer: r } });
    expect(reviewer({ runtime: "pi", model: "ollama/x" })).toThrow(/needs the ollama pin/);
    expect(
      reviewer({
        runtime: "pi",
        model: "ollama/x",
        ollama: { ...pin, url: "http://192.168.1.5:11434" },
      }),
    ).toThrow(/127\.0\.0\.1/);
    expect(
      reviewer({
        runtime: "pi",
        model: "ollama/x",
        ollama: { ...pin, baseModel: "qwen2.5-coder:latest" },
      }),
    ).toThrow(/exact tag/);
    expect(reviewer({ runtime: "claude-code", model: "opus", ollama: pin })).toThrow(
      /only for the pi runtime/,
    );
    expect(reviewer({ runtime: "pi", model: "anthropic/claude-opus-5-5" })).toThrow(
      /must not use Anthropic\/Claude/,
    );
    expect(reviewer({ runtime: "pi", model: "github-copilot/claude-sonnet-5.5" })).toThrow(
      /must not use Anthropic\/Claude/,
    );
  });
});
