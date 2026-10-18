import { z } from "zod";
import { CheckSchema, TargetSourceSchema, type Check } from "./config.js";
import { MAX_CYCLES_PER_KIND } from "./task.js";

/**
 * Splits a command line from a project config into argv. Deliberately not a shell: only
 * words separated by spaces, with no quoting, globbing, variables, redirection or command
 * chaining. Anything shell-like is rejected, so a config can never smuggle a second command.
 * Returns null for an invalid command.
 */
export function splitCommand(line: string): string[] | null {
  const trimmed = line.trim();
  if (trimmed === "" || /[;&|<>`$\\"'(){}*?[\]~!#\n]/.test(trimmed)) return null;
  const argv = trimmed.split(/ +/);
  return argv.every((a) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(a)) ? argv : null;
}

const CommandLine = z
  .string()
  .min(1)
  .refine((s) => splitCommand(s) !== null, {
    message: "must be plain words separated by spaces (no shell syntax, quotes or variables)",
  });

/** A repo-relative path or glob: no absolute paths, no `..`, forward slashes. */
const RepoPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes("..") && !p.includes("\\"), {
    message: "must be a repository-relative path without '..'",
  });

/** Sandbox image name = a directory `sandbox/<name>/` in the factory repository. */
export const PROFILE_IMAGE_PATTERN = /^[a-z][a-z0-9-]*$/;

export const ProjectConfigSchema = z.strictObject({
  version: z.literal(1),
  profile: z.strictObject({
    /** Directory `sandbox/<image>/` (Dockerfile + bootstrap.sh) in the factory repository. */
    image: z.string().regex(PROFILE_IMAGE_PATTERN),
    /** Files copied into the image build context (under deps/); they define the image tag. */
    dependency_files: z.array(RepoPath).min(1),
    /** Dependency directory installed on the host and linked into worktrees (developer checks). */
    host_deps_dir: z.string().regex(/^[A-Za-z0-9._-]+$/),
    /** Host install of dependencies (network allowed), run in the project's main clone. */
    install: CommandLine,
    /** Checks run by the Quality Gate inside the sandbox, in order. */
    checks: z
      .array(z.strictObject({ name: z.string().regex(/^[a-z][a-z0-9-]*$/), run: CommandLine }))
      .min(1),
    /** Exact commands the developer may run on the host (`Bash(<command>)`, no wildcards). */
    agent_commands: z.array(CommandLine).min(1),
    /** The command the developer is told to run before finishing (one of agent_commands). */
    self_check: CommandLine,
  }),
  /** Repository conventions file injected into every agent's system prompt. */
  conventions_file: RepoPath,
  scope: z.strictObject({
    /** Default allowed paths for tasks that do not set their own scope. */
    allowed_paths: z.array(RepoPath).min(1),
    /** Never changed by an agent; a change is a gate policy violation. */
    protected_paths: z.array(RepoPath).default([]),
  }),
  budget_defaults: z.strictObject({
    max_gate_fix_cycles: z.number().int().min(0).max(MAX_CYCLES_PER_KIND),
    max_review_cycles: z.number().int().min(0).max(MAX_CYCLES_PER_KIND),
    max_cost_usd: z.number().positive(),
    timeout_minutes: z.number().positive(),
  }),
  target_branch: z.string().regex(/^[A-Za-z0-9._/-]+$/),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** Cross-field rules (applied after the schema). */
export function projectConfigIssues(c: ProjectConfig): string[] {
  const issues: string[] = [];
  if (!c.profile.agent_commands.includes(c.profile.self_check)) {
    issues.push("profile.self_check must be one of profile.agent_commands");
  }
  const names = c.profile.checks.map((x) => x.name);
  if (new Set(names).size !== names.length) issues.push("profile.checks names must be unique");
  if (!c.scope.protected_paths.some((p) => p === ".factory/**")) {
    issues.push(
      'scope.protected_paths must include ".factory/**" (agents may not edit their rules)',
    );
  }
  return issues;
}

/** The gate's checks as argv (the schema guarantees every `run` splits). */
export function profileChecks(c: ProjectConfig): Check[] {
  return c.profile.checks.map((x) =>
    CheckSchema.parse({ name: x.name, command: splitCommand(x.run) ?? [] }),
  );
}

export const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export const ProjectEntrySchema = z.strictObject({
  id: z.string().regex(PROJECT_ID_PATTERN),
  /** Where the factory gets the repository: a fixture in this repo, or a git URL / path. */
  source: TargetSourceSchema,
  /** GitHub repository `owner/name` (Phase 3); null for a CLI-only project. */
  github: z
    .strictObject({ repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/) })
    .nullable()
    .default(null),
  /** GitHub logins whose issues and commands are accepted (exact, case-insensitive). */
  allowed_users: z.array(z.string().regex(/^[A-Za-z0-9-]+$/)).default([]),
});
export type ProjectEntry = z.infer<typeof ProjectEntrySchema>;

export const ProjectRegistrySchema = z
  .strictObject({ version: z.literal(1), projects: z.array(ProjectEntrySchema).min(1) })
  .superRefine((r, ctx) => {
    const ids = r.projects.map((p) => p.id);
    ids.forEach((id, i) => {
      if (ids.indexOf(id) !== i)
        ctx.addIssue({
          code: "custom",
          message: `duplicate project id "${id}"`,
          path: ["projects", i],
        });
    });
    r.projects.forEach((p, i) => {
      if (p.github && p.allowed_users.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: `project "${p.id}" has a GitHub repo but no allowed_users`,
          path: ["projects", i, "allowed_users"],
        });
      }
    });
  });
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;

/**
 * The eval stand (`evals/eval.config.yaml`): which registered project the hidden tests belong
 * to, where eval materializes it from (never GitHub), and how hidden tests are run.
 */
export const EvalConfigSchema = z.strictObject({
  version: z.literal(1),
  project: z.string().regex(PROJECT_ID_PATTERN),
  /** Eval source; overrides the registry so eval never depends on a remote. */
  source: TargetSourceSchema,
  hidden_tests: z.strictObject({
    /** Where hidden tests are placed inside a throwaway copy of the target. */
    dir: RepoPath,
    /** Runs the tests in `$1` and prints a JSON report to stdout (run via `sh -c`). */
    script: z.string().min(1),
    report: z.literal("vitest-json"),
    /** Full check run on reference implementations by verify-hidden. */
    reference_check: CommandLine,
  }),
});
export type EvalConfig = z.infer<typeof EvalConfigSchema>;
