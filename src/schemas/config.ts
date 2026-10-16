import { z } from "zod";

const Argv = z.array(z.string().min(1)).min(1);

export const TargetSourceSchema = z.discriminatedUnion("kind", [
  /** Plain files in this repository, materialized into a fresh git repo by the factory. */
  z.strictObject({ kind: z.literal("fixture"), path: z.string().min(1) }),
  /** An existing git repository (URL or local path), cloned by the factory. */
  z.strictObject({ kind: z.literal("git"), url: z.string().min(1), ref: z.string().min(1) }),
]);
export type TargetSource = z.infer<typeof TargetSourceSchema>;

export const CheckSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  command: Argv,
});
export type Check = z.infer<typeof CheckSchema>;

export const TargetConfigSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  source: TargetSourceSchema,
  /** Installs dependencies on the host for the developer's own checks (network allowed). */
  install: Argv,
  /** Checks run by the Quality Gate inside the sandbox, in order. */
  checks: z.array(CheckSchema).min(1),
  /** Repository conventions file injected into every agent's system prompt. */
  conventionsFile: z.string().min(1),
});
export type TargetConfig = z.infer<typeof TargetConfigSchema>;

const Minutes = z.number().positive();

export const RUNTIME_NAMES = ["claude-code", "opencode"] as const;

export const RoleBindingSchema = z.strictObject({
  runtime: z.enum(RUNTIME_NAMES),
  /** Exact model id (no moving aliases for OpenCode, e.g. "openai/<model-id>"). */
  model: z.string().min(1),
  /** Env var names passed to this runtime's process (e.g. its provider key). OpenCode only. */
  keyEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
});
export type RoleBinding = z.infer<typeof RoleBindingSchema>;

export const FactoryConfigSchema = z.strictObject({
  /** Where target repos and worktrees live. Must be outside this repository. `~` expands. */
  workdir: z.string().min(1),
  target: TargetConfigSchema,
  /**
   * Runtime and model per role. Switching a role to another runtime is a config change, not
   * a code change. OpenCode runs read-only, so it may only serve planner/reviewer.
   */
  roles: z.strictObject({
    planner: RoleBindingSchema,
    developer: RoleBindingSchema,
    reviewer: RoleBindingSchema,
  }),
  /** Reviewers compared by `npm run eval:review` (each must satisfy the same binding rules). */
  reviewEval: z
    .strictObject({ reviewers: z.array(RoleBindingSchema).min(1) })
    .default({ reviewers: [{ runtime: "claude-code", model: "opus", keyEnv: [] }] }),
  /** Environment variables holding secrets (provider keys): masked in DB, logs and reports. */
  secretEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
  stepTimeoutsMinutes: z.strictObject({
    planner: Minutes,
    developer: Minutes,
    reviewer: Minutes,
    check: Minutes,
  }),
  /** Diffs larger than this are truncated in the reviewer prompt (full diff stays in the report). */
  maxDiffCharsForReview: z.number().int().positive(),
  /** Global spend cap for one `npm run eval` (USD); remaining tasks are skipped once reached. */
  evalCostCapUsd: z.number().positive(),
});
export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;

/** Cross-field rules for role bindings (applied after the schema). */
export function roleBindingIssues(c: FactoryConfig): string[] {
  const issues: string[] = [];
  if (c.roles.developer.runtime === "opencode") {
    issues.push("roles.developer: the OpenCode runtime is read-only and cannot be the developer");
  }
  for (const role of ["planner", "reviewer"] as const) {
    const b = c.roles[role];
    if (b.runtime !== "opencode") continue;
    if (!/^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/.test(b.model)) {
      issues.push(`roles.${role}.model must be "provider/model-id" for OpenCode`);
    }
    if (/latest/i.test(b.model)) {
      issues.push(`roles.${role}.model must be an exact model id, not an alias like "latest"`);
    }
    if (b.model === c.roles.developer.model) {
      issues.push(
        `roles.${role}.model must differ from the developer's model for an independent review`,
      );
    }
    if (b.keyEnv.length === 0)
      issues.push(`roles.${role}.keyEnv must name the provider key variable`);
  }
  c.reviewEval.reviewers.forEach((b, i) => {
    if (b.runtime !== "opencode") return;
    if (!/^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/.test(b.model) || /latest/i.test(b.model)) {
      issues.push(`reviewEval.reviewers[${i}].model must be an exact "provider/model-id"`);
    }
    if (b.keyEnv.length === 0)
      issues.push(`reviewEval.reviewers[${i}].keyEnv must name the provider key variable`);
    for (const k of b.keyEnv) {
      if (!c.secretEnv.includes(k))
        issues.push(`reviewEval.reviewers[${i}].keyEnv ${k} must also be listed in secretEnv`);
    }
  });
  for (const role of ["planner", "developer", "reviewer"] as const) {
    for (const k of c.roles[role].keyEnv) {
      if (!c.secretEnv.includes(k))
        issues.push(`roles.${role}.keyEnv ${k} must also be listed in secretEnv`);
    }
  }
  return issues;
}
