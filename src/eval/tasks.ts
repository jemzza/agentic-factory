import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { HIDDEN_DIR, REFERENCE_DIR, TASKS_DIR } from "../paths.js";
import {
  EvalMetaSchema,
  TASK_ID_PATTERN,
  TaskSpecSchema,
  type EvalMeta,
  type TaskSpec,
} from "../schemas/task.js";

export interface EvalDirs {
  tasksDir: string;
  hiddenDir: string;
  referenceDir: string;
}

export const DEFAULT_EVAL_DIRS: EvalDirs = {
  tasksDir: TASKS_DIR,
  hiddenDir: HIDDEN_DIR,
  referenceDir: REFERENCE_DIR,
};

async function readYaml<S extends z.ZodType>(file: string, schema: S): Promise<z.output<S>> {
  const raw: unknown = parseYaml(await readFile(file, "utf8"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ${file}:\n${issues}`);
  }
  return parsed.data;
}

/** Loads and validates the visible task definition. The file's `id` must match its directory. */
export async function loadTaskSpec(
  id: string,
  dirs: EvalDirs = DEFAULT_EVAL_DIRS,
): Promise<TaskSpec> {
  if (!TASK_ID_PATTERN.test(id)) throw new Error(`Invalid task id "${id}"`);
  const file = path.join(dirs.tasksDir, id, "task.yaml");
  const spec = await readYaml(file, TaskSpecSchema);
  if (spec.id !== id) throw new Error(`${file}: id "${spec.id}" does not match directory "${id}"`);
  return spec;
}

/** Loads eval-only metadata. Never pass this to an agent. */
export async function loadEvalMeta(
  id: string,
  dirs: EvalDirs = DEFAULT_EVAL_DIRS,
): Promise<EvalMeta> {
  return readYaml(path.join(dirs.hiddenDir, id, "meta.yaml"), EvalMetaSchema);
}

/** Task ids with a `task.yaml`, sorted. */
export async function listTaskIds(dirs: EvalDirs = DEFAULT_EVAL_DIRS): Promise<string[]> {
  const entries = await readdir(dirs.tasksDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && TASK_ID_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** Absolute paths of the hidden test files for a task (`*.test.ts`). */
export async function listHiddenTestFiles(
  id: string,
  dirs: EvalDirs = DEFAULT_EVAL_DIRS,
): Promise<string[]> {
  const dir = path.join(dirs.hiddenDir, id);
  const entries = await readdir(dir);
  return entries
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => path.join(dir, name));
}

export function referencePatchPath(id: string, dirs: EvalDirs = DEFAULT_EVAL_DIRS): string {
  return path.join(dirs.referenceDir, `${id}.patch`);
}
