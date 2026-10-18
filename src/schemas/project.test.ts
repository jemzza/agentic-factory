import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseProjectConfig } from "../config/projects.js";
import { FAKE_PROJECT_CONFIG_YAML } from "../testing/fakes.js";
import { protectedPathViolations } from "../workflow/nodes.js";
import { EvalConfigSchema, profileChecks, ProjectRegistrySchema, splitCommand } from "./project.js";

const withProfile = (patch: Record<string, unknown>) => {
  const doc = parseYaml(FAKE_PROJECT_CONFIG_YAML) as Record<string, Record<string, unknown>>;
  return JSON.stringify({ ...doc, profile: { ...doc["profile"], ...patch } });
};

describe("splitCommand", () => {
  it("splits plain words", () => {
    expect(splitCommand("npm run check")).toEqual(["npm", "run", "check"]);
    expect(splitCommand("  ruff  check . ")).toEqual(["ruff", "check", "."]);
    expect(splitCommand("npm ci --no-audit --no-fund")).toEqual([
      "npm",
      "ci",
      "--no-audit",
      "--no-fund",
    ]);
    expect(splitCommand("mypy --strict src/ledgerlite")).toEqual([
      "mypy",
      "--strict",
      "src/ledgerlite",
    ]);
  });

  it.each([
    "npm test; rm -rf /",
    "npm test && curl x",
    "npm test | tee x",
    "echo $HOME",
    "echo `id`",
    'npm run "check"',
    "cat ~/.ssh/id_rsa",
    "npm test > out",
    "ls *",
    "",
    "a\nb",
  ])("rejects shell syntax: %j", (line) => {
    expect(splitCommand(line)).toBeNull();
  });
});

describe("ProjectConfigSchema", () => {
  it("parses the fake project's config and turns checks into argv", () => {
    const c = parseProjectConfig(FAKE_PROJECT_CONFIG_YAML, "fake");
    expect(profileChecks(c)).toEqual([
      { name: "typecheck", command: ["npm", "run", "typecheck"] },
      { name: "test", command: ["npm", "test"] },
    ]);
    expect(c.target_branch).toBe("main");
  });

  it("rejects shell syntax in any command", () => {
    expect(() =>
      parseProjectConfig(
        withProfile({ checks: [{ name: "test", run: "npm test; curl evil" }] }),
        "x",
      ),
    ).toThrow(/no shell syntax/);
    expect(() => parseProjectConfig(withProfile({ install: "curl x | sh" }), "x")).toThrow(
      /no shell syntax/,
    );
  });

  it("requires self_check to be an allowed agent command and .factory/** to be protected", () => {
    expect(() => parseProjectConfig(withProfile({ self_check: "make check" }), "x")).toThrow(
      /self_check must be one of profile.agent_commands/,
    );
    const doc = parseYaml(FAKE_PROJECT_CONFIG_YAML) as Record<string, unknown>;
    expect(() =>
      parseProjectConfig(
        JSON.stringify({ ...doc, scope: { allowed_paths: ["src/**"], protected_paths: [] } }),
        "x",
      ),
    ).toThrow(/\.factory\/\*\*/);
  });

  it("rejects paths escaping the repository and unknown keys", () => {
    expect(() =>
      parseProjectConfig(withProfile({ dependency_files: ["../secrets.json"] }), "x"),
    ).toThrow(/repository-relative/);
    expect(() => parseProjectConfig(withProfile({ image: "../evil" }), "x")).toThrow();
    expect(() => parseProjectConfig(withProfile({ network: true }), "x")).toThrow();
  });

  it("caps budget defaults at the factory's cycle limit", () => {
    const doc = parseYaml(FAKE_PROJECT_CONFIG_YAML) as Record<string, Record<string, unknown>>;
    const over = { ...doc, budget_defaults: { ...doc["budget_defaults"], max_review_cycles: 3 } };
    expect(() => parseProjectConfig(JSON.stringify(over), "x")).toThrow();
  });
});

describe("protectedPathViolations", () => {
  it("flags changed files under protected paths only", () => {
    const c = parseProjectConfig(FAKE_PROJECT_CONFIG_YAML, "fake");
    expect(
      protectedPathViolations(c, [
        "src/a.ts",
        ".factory/config.yaml",
        "CLAUDE.md",
        "docs/CLAUDE.md",
      ]),
    ).toEqual([
      "`.factory/config.yaml` is a protected path of this project and may not be changed; revert it",
      "`CLAUDE.md` is a protected path of this project and may not be changed; revert it",
    ]);
  });
});

describe("ProjectRegistrySchema", () => {
  const p = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    source: { kind: "fixture", path: `fixtures/${id}` },
    ...extra,
  });

  it("accepts CLI-only projects and defaults github/allowed_users", () => {
    const r = ProjectRegistrySchema.parse({ version: 1, projects: [p("a")] });
    expect(r.projects[0]).toMatchObject({ github: null, allowed_users: [] });
  });

  it("rejects duplicate ids and a GitHub project without allowed users", () => {
    expect(
      ProjectRegistrySchema.safeParse({ version: 1, projects: [p("a"), p("a")] }).success,
    ).toBe(false);
    expect(
      ProjectRegistrySchema.safeParse({
        version: 1,
        projects: [p("a", { github: { repo: "owner/a" } })],
      }).success,
    ).toBe(false);
    expect(
      ProjectRegistrySchema.safeParse({
        version: 1,
        projects: [p("a", { github: { repo: "owner/a" }, allowed_users: ["owner"] })],
      }).success,
    ).toBe(true);
  });
});

describe("EvalConfigSchema", () => {
  it("requires a reference check without shell syntax", () => {
    const base = {
      version: 1,
      project: "a",
      source: { kind: "fixture", path: "fixtures/a" },
      hidden_tests: {
        dir: "tests/__hidden__",
        script: "x",
        report: "vitest-json",
        reference_check: "npm run check",
      },
    };
    expect(EvalConfigSchema.safeParse(base).success).toBe(true);
    expect(
      EvalConfigSchema.safeParse({
        ...base,
        hidden_tests: { ...base.hidden_tests, reference_check: "npm run check && rm -rf /" },
      }).success,
    ).toBe(false);
  });
});
