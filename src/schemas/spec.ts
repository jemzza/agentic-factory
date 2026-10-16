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

export const SpecRequirementSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
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

/** One issue from `openspec validate --json` (see Phase 0 probe). */
export const OpenSpecIssueSchema = z.looseObject({
  level: z.string(),
  path: z.string().optional(),
  line: z.number().optional(),
  message: z.string(),
});
export type OpenSpecIssue = z.infer<typeof OpenSpecIssueSchema>;
