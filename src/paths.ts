import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the factory repository root (works from src/ via tsx and from dist/). */
export const FACTORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const EVALS_DIR = path.join(FACTORY_ROOT, "evals");
export const TASKS_DIR = path.join(EVALS_DIR, "tasks");
export const HIDDEN_DIR = path.join(EVALS_DIR, "hidden");
export const REFERENCE_DIR = path.join(EVALS_DIR, "reference");
export const FIXTURES_DIR = path.join(FACTORY_ROOT, "fixtures");

/** Shared helper copied next to hidden tests. */
export const HIDDEN_HARNESS_FILE = path.join(HIDDEN_DIR, "_harness.ts");

/** Where hidden tests are placed inside a throwaway copy of the target repository. */
export const HIDDEN_TESTS_DIR_IN_TARGET = path.join("tests", "__hidden__");
