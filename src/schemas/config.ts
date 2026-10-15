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

export const FactoryConfigSchema = z.strictObject({
  /** Where target repos and worktrees live. Must be outside this repository. `~` expands. */
  workdir: z.string().min(1),
  target: TargetConfigSchema,
  models: z.strictObject({ planner: z.string(), developer: z.string(), reviewer: z.string() }),
  stepTimeoutsMinutes: z.strictObject({
    planner: Minutes,
    developer: Minutes,
    reviewer: Minutes,
    check: Minutes,
  }),
  /** Diffs larger than this are truncated in the reviewer prompt (full diff stays in the report). */
  maxDiffCharsForReview: z.number().int().positive(),
});
export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;
