import { z } from "zod";

/**
 * Structured OpenSpec change proposal produced by the Planner. The factory renders it into
 * OpenSpec files deterministically (src/spec/openspec.ts), so the format is guaranteed by
 * code; `openspec validate --strict` then checks the content.
 *
 * Constraints mirror OpenSpec 1.14.2 strict validation (verified in Phase 0): requirements
 * use SHALL/MUST, every requirement has a scenario, a new capability's purpose is ≥ 50 chars,
 * requirement descriptions are ≤ 500 chars.
 */
const kebabPath = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/,
    "kebab-case path, e.g. task-lifecycle",
  );

export const SpecScenarioSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  when: z.string().trim().min(1),
  then: z.string().trim().min(1),
});

/**
 * Where a requirement comes from: an acceptance criterion (1-based number) or behavior the
 * code already has. Ideas beyond these belong in the plan's risks or questions, not here.
 */
export const SPEC_SOURCE_PATTERN = /^(acceptance:[1-9]\d*|existing_behavior)$/;

export const SpecRequirementSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  source: z
    .string()
    .regex(
      SPEC_SOURCE_PATTERN,
      'source must be "acceptance:<criterion number>" or "existing_behavior"',
    ),
  /** Normative description: one behavior, using SHALL or MUST. */
  text: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((t) => /\b(SHALL|MUST)\b/.test(t), "requirement text must use SHALL or MUST"),
  scenarios: z.array(SpecScenarioSchema).min(1),
});

export const SpecCapabilitySchema = z.strictObject({
  /** Capability path under openspec/specs/ (a durable behavior, not the task name). */
  path: kebabPath,
  /** "new" creates the capability; "modified" adds requirements to an existing one. */
  kind: z.enum(["new", "modified"]),
  /** Required for new capabilities (≥ 50 chars); ignored for modified ones. */
  purpose: z.string().trim(),
  requirements: z.array(SpecRequirementSchema).min(1),
});

export const SpecChangeSchema = z
  .strictObject({
    why: z.string().trim().min(1),
    what_changes: z.array(z.string().trim().min(1)).min(1),
    capabilities: z.array(SpecCapabilitySchema).min(1),
    impact: z.string().trim().min(1),
    tasks: z.array(z.string().trim().min(1)).min(1),
  })
  .superRefine((spec, ctx) => {
    spec.capabilities.forEach((c, i) => {
      if (c.kind === "new" && c.purpose.length < 50) {
        ctx.addIssue({
          code: "custom",
          path: ["capabilities", i, "purpose"],
          message: "a new capability needs a purpose of at least 50 characters",
        });
      }
    });
    const paths = spec.capabilities.map((c) => c.path);
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "capability paths must be unique",
      });
    }
  });
export type SpecChange = z.infer<typeof SpecChangeSchema>;

/**
 * Shape of specs already stored in checkpoints and reports. Specs drafted before the
 * `source` rule have no `source`; history must stay readable, so it is optional here and
 * no refinements are re-applied. New specs are always checked with SpecChangeSchema.
 */
export const PersistedSpecChangeSchema = z.strictObject({
  why: z.string(),
  what_changes: z.array(z.string()),
  capabilities: z.array(
    z.strictObject({
      path: z.string(),
      kind: z.enum(["new", "modified"]),
      purpose: z.string(),
      requirements: z.array(
        z.strictObject({
          name: z.string(),
          source: z.string().optional(),
          text: z.string(),
          scenarios: z.array(
            z.strictObject({ name: z.string(), when: z.string(), then: z.string() }),
          ),
        }),
      ),
    }),
  ),
  impact: z.string(),
  tasks: z.array(z.string()),
});
export type PersistedSpecChange = z.infer<typeof PersistedSpecChangeSchema>;

/** One issue from `openspec validate --json` (see Phase 0 probe). */
export const OpenSpecIssueSchema = z.looseObject({
  level: z.string(),
  path: z.string().optional(),
  line: z.number().optional(),
  message: z.string(),
});
export type OpenSpecIssue = z.infer<typeof OpenSpecIssueSchema>;

export type SpecCheck = { ok: true; value: SpecChange } | { ok: false; issues: OpenSpecIssue[] };

/**
 * Validates a raw spec from the Planner: the Zod schema, plus every `acceptance:<n>` source
 * must name an existing acceptance criterion. Failures are reported in the same shape as
 * `openspec validate` issues, so both kinds go through the same single fix attempt.
 */
export function checkSpec(raw: unknown, criteriaCount: number): SpecCheck {
  const parsed = SpecChangeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        level: "ERROR",
        path: i.path.join("."),
        message: i.message,
      })),
    };
  }
  const issues: OpenSpecIssue[] = [];
  parsed.data.capabilities.forEach((c, ci) => {
    c.requirements.forEach((r, ri) => {
      const m = /^acceptance:(\d+)$/.exec(r.source);
      if (m && Number(m[1]) > criteriaCount) {
        issues.push({
          level: "ERROR",
          path: `capabilities.${ci}.requirements.${ri}.source`,
          message: `"${r.source}" does not exist: the task has ${criteriaCount} acceptance criteria`,
        });
      }
    });
  });
  return issues.length ? { ok: false, issues } : { ok: true, value: parsed.data };
}
