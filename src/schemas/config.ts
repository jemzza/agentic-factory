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

const Minutes = z.number().positive();

/**
 * The embedder that turns memory records into vectors. Provider-neutral: a local Ollama model
 * (pinned by tag AND digest, loopback only) or an OpenAI embedding model (key from .env).
 * Records store the embedder they were indexed with; a different one needs a reindex.
 */
export const EmbedderConfigSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("ollama"),
    /** Only the local service; never another host (owner's rule). */
    url: z
      .string()
      .regex(/^http:\/\/127\.0\.0\.1:\d{2,5}$/, "Ollama must be http://127.0.0.1:<port>"),
    /** Model with an explicit tag, e.g. "nomic-embed-text:latest". */
    model: z.string().regex(/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+$/, "model must have a tag"),
    /** First 12 hex chars of the model digest (`ollama list`); `latest` moves, the digest does not. */
    digest: z.string().regex(/^[0-9a-f]{12}$/),
    dims: z.number().int().positive(),
  }),
  z.strictObject({
    provider: z.literal("openai"),
    model: z.string().min(1),
    dims: z.number().int().positive(),
    /** .env variable with the key; must be listed in secretEnv. */
    keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  }),
]);
export type EmbedderConfig = z.infer<typeof EmbedderConfigSchema>;

/** Identity of an embedder's vector space, written into every record and into the index. */
export function embedModelId(e: EmbedderConfig): string {
  return e.provider === "ollama" ? `ollama/${e.model}@${e.digest}` : `openai/${e.model}`;
}

export const MemoryConfigSchema = z.strictObject({
  /** Read and write project memory in runs. Default off until the A/B result (Phase 5). */
  enabled: z.boolean(),
  /** At most this many records go into the planner's "Project knowledge" block. */
  limit: z.number().int().min(1).max(20),
  embedder: EmbedderConfigSchema,
  /** Mem0's vector index files, relative to the factory root (git-ignored data/). */
  indexDir: z.string().min(1),
});
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
  limit: 5,
  embedder: {
    provider: "ollama",
    url: "http://127.0.0.1:11434",
    model: "nomic-embed-text:latest",
    digest: "0a109f422b47",
    dims: 768,
  },
  indexDir: "data/memory",
};

export const RUNTIME_NAMES = ["claude-code", "opencode", "pi"] as const;

/** Runtimes that only read (no file edits, no commands): planner and reviewer only. */
export const READ_ONLY_RUNTIMES: readonly string[] = ["opencode", "pi"];

export const RoleBindingSchema = z.strictObject({
  runtime: z.enum(RUNTIME_NAMES),
  /** Exact model id (no moving aliases for OpenCode, e.g. "openai/<model-id>"). */
  model: z.string().min(1),
  /**
   * Env var names passed to this runtime's process (its provider key). OpenCode and Pi only.
   * Pi may have none: a subscription signed in to in the factory's own Pi agent dir.
   */
  keyEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
  /**
   * Pi on a local Ollama model (src/runtimes/pi-ollama.ts): the base tag pinned by digest, the
   * derived model (`model: "ollama/<name>"`) created from a Modelfile in ollama/ with num_ctx.
   * Ollama only on 127.0.0.1.
   */
  ollama: z
    .strictObject({
      url: z
        .string()
        .regex(/^http:\/\/127\.0\.0\.1:\d{2,5}$/, "Ollama must be on http://127.0.0.1:<port>")
        .default("http://127.0.0.1:11434"),
      baseModel: z.string().regex(/^[a-z0-9._-]+(\/[a-z0-9._-]+)?:[A-Za-z0-9._-]+$/, "name:tag"),
      digest: z.string().regex(/^[0-9a-f]{12}$/, "12 hex characters"),
      numCtx: z.number().int().min(4096).max(262144),
      modelfile: z.string().regex(/^ollama\/[A-Za-z0-9._-]+\.Modelfile$/),
    })
    .optional(),
});
export type RoleBinding = z.infer<typeof RoleBindingSchema>;
export type RoleBindingInput = z.input<typeof RoleBindingSchema>;

export const FactoryConfigSchema = z.strictObject({
  /** Where target repos and worktrees live. Must be outside this repository. `~` expands. */
  workdir: z.string().min(1),
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
  /** Project memory (Week 3 Phase 5). Off until the A/B measurement says otherwise. */
  memory: MemoryConfigSchema.default(DEFAULT_MEMORY_CONFIG),
  /** GitHub interface (`npm run factory:watch`). The token itself lives in .env only. */
  github: z
    .strictObject({
      /** .env variable with the fine-grained token; must also be listed in secretEnv. */
      tokenEnv: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/)
        .default("FACTORY_GITHUB_TOKEN"),
      /** Poll interval per cycle over all projects (GitHub's primary limit is 5,000 req/h). */
      pollIntervalSeconds: z.number().int().min(15).default(60),
    })
    .default({ tokenEnv: "FACTORY_GITHUB_TOKEN", pollIntervalSeconds: 60 }),
});
export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;

/** Cross-field rules for role bindings (applied after the schema). */
export function roleBindingIssues(c: FactoryConfig): string[] {
  const issues: string[] = [];
  if (READ_ONLY_RUNTIMES.includes(c.roles.developer.runtime)) {
    issues.push(
      `roles.developer: the ${c.roles.developer.runtime} runtime is read-only and cannot be the developer`,
    );
  }
  for (const role of ["planner", "reviewer"] as const) {
    const b = c.roles[role];
    if (!READ_ONLY_RUNTIMES.includes(b.runtime)) continue;
    if (!/^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/.test(b.model)) {
      issues.push(`roles.${role}.model must be "provider/model-id" for ${b.runtime}`);
    }
    if (/latest/i.test(b.model)) {
      issues.push(`roles.${role}.model must be an exact model id, not an alias like "latest"`);
    }
    if (b.model === c.roles.developer.model) {
      issues.push(
        `roles.${role}.model must differ from the developer's model for an independent review`,
      );
    }
    if (b.runtime === "opencode" && b.keyEnv.length === 0)
      issues.push(`roles.${role}.keyEnv must name the provider key variable`);
  }
  c.reviewEval.reviewers.forEach((b, i) => {
    if (!READ_ONLY_RUNTIMES.includes(b.runtime)) return;
    if (!/^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/.test(b.model) || /latest/i.test(b.model)) {
      issues.push(`reviewEval.reviewers[${i}].model must be an exact "provider/model-id"`);
    }
    if (b.runtime === "opencode" && b.keyEnv.length === 0)
      issues.push(`reviewEval.reviewers[${i}].keyEnv must name the provider key variable`);
    for (const k of b.keyEnv) {
      if (!c.secretEnv.includes(k))
        issues.push(`reviewEval.reviewers[${i}].keyEnv ${k} must also be listed in secretEnv`);
    }
  });
  if (c.memory.embedder.provider === "openai" && !c.secretEnv.includes(c.memory.embedder.keyEnv)) {
    issues.push(
      `memory.embedder.keyEnv ${c.memory.embedder.keyEnv} must also be listed in secretEnv`,
    );
  }
  if (!c.secretEnv.includes(c.github.tokenEnv)) {
    issues.push(`github.tokenEnv ${c.github.tokenEnv} must also be listed in secretEnv`);
  }
  const bindings = [
    ...(["planner", "developer", "reviewer"] as const).map(
      (r) => [`roles.${r}`, c.roles[r]] as const,
    ),
    ...c.reviewEval.reviewers.map((b, i) => [`reviewEval.reviewers[${String(i)}]`, b] as const),
  ];
  for (const [where, b] of bindings) {
    const isOllamaModel = b.model.startsWith("ollama/");
    if (b.ollama && b.runtime !== "pi") issues.push(`${where}.ollama is only for the pi runtime`);
    if (b.runtime === "pi" && isOllamaModel !== (b.ollama !== undefined)) {
      issues.push(
        `${where}: an "ollama/<model>" needs the ollama pin, and the pin needs that model`,
      );
    }
    if (b.ollama && /:latest$/.test(b.ollama.baseModel)) {
      issues.push(`${where}.ollama.baseModel must be an exact tag, not "latest"`);
    }
    // Owner's decision: the Claude subscription is never connected to Pi, in any form.
    if (
      b.runtime === "pi" &&
      (/^(anthropic|claude)/i.test(b.model) ||
        /claude/i.test(b.model) ||
        b.keyEnv.some((k) => /^(ANTHROPIC|CLAUDE)/.test(k)))
    ) {
      issues.push(`${where}: Pi must not use Anthropic/Claude models or credentials`);
    }
  }
  for (const role of ["planner", "developer", "reviewer"] as const) {
    for (const k of c.roles[role].keyEnv) {
      if (!c.secretEnv.includes(k))
        issues.push(`roles.${role}.keyEnv ${k} must also be listed in secretEnv`);
    }
  }
  return issues;
}
