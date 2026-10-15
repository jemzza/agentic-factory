import { z } from "zod";
import { TASK_STATUSES } from "../domain/task.js";
import { validationError } from "../errors.js";

export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2000;

export const taskStatusSchema = z.enum(TASK_STATUSES);
export const titleSchema = z.string().trim().min(1).max(TITLE_MAX_LENGTH);
export const descriptionSchema = z.string().max(DESCRIPTION_MAX_LENGTH);

export const taskIdParamsSchema = z.object({ id: z.string().min(1) });

/**
 * Parses untrusted input with a Zod schema.
 * Throws VALIDATION_ERROR with per-field issues on failure.
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw validationError(
      "Request validation failed",
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
