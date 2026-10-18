import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { GitError, git } from "../git/git.js";
import { EVALS_DIR, FACTORY_ROOT } from "../paths.js";
import {
  EvalConfigSchema,
  ProjectConfigSchema,
  projectConfigIssues,
  ProjectRegistrySchema,
  type EvalConfig,
  type ProjectConfig,
  type ProjectEntry,
  type ProjectRegistry,
} from "../schemas/project.js";

/** The project registry; FACTORY_PROJECTS points to another one (the demo's, scripts/demo.ts). */
export const REGISTRY_FILE = path.resolve(
  process.env["FACTORY_PROJECTS"] ?? path.join(FACTORY_ROOT, "projects.yaml"),
);
export const EVAL_CONFIG_FILE = path.join(EVALS_DIR, "eval.config.yaml");
/** Location of a project's factory settings inside its own repository. */
export const PROJECT_CONFIG_PATH = ".factory/config.yaml";

async function readYamlFile(file: string): Promise<unknown> {
  return parseYaml(await readFile(file, "utf8")) as unknown;
}

export async function loadRegistry(file: string = REGISTRY_FILE): Promise<ProjectRegistry> {
  const parsed = ProjectRegistrySchema.safeParse(await readYamlFile(file));
  if (!parsed.success) throw new Error(`Invalid ${file}: ${parsed.error.message}`);
  return parsed.data;
}

export function findProject(registry: ProjectRegistry, id: string): ProjectEntry {
  const p = registry.projects.find((x) => x.id === id);
  if (!p) {
    throw new Error(
      `unknown project "${id}" (registered: ${registry.projects.map((x) => x.id).join(", ")})`,
    );
  }
  return p;
}

export async function loadEvalConfig(file: string = EVAL_CONFIG_FILE): Promise<EvalConfig> {
  const parsed = EvalConfigSchema.safeParse(await readYamlFile(file));
  if (!parsed.success) throw new Error(`Invalid ${file}: ${parsed.error.message}`);
  return parsed.data;
}

/** Parses and checks a project config document (YAML text). */
export function parseProjectConfig(text: string, source: string): ProjectConfig {
  const parsed = ProjectConfigSchema.safeParse(parseYaml(text) as unknown);
  if (!parsed.success) throw new Error(`Invalid ${source}: ${parsed.error.message}`);
  const issues = projectConfigIssues(parsed.data);
  if (issues.length) throw new Error(`Invalid ${source}:\n- ${issues.join("\n- ")}`);
  return parsed.data;
}

/** A file as committed at `ref` in the project's main clone, or null if it is not there. */
export async function showFile(repoDir: string, ref: string, file: string): Promise<string | null> {
  try {
    return await git(repoDir, ["show", `${ref}:${file}`]);
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
}

/**
 * The project's settings as COMMITTED at `ref` in its main clone (`git show`), never from an
 * agent's worktree: an agent cannot change the rules it is checked by. `ref` is the target
 * branch for interactive runs and the baseline tag for eval runs.
 */
export async function readProjectConfig(
  repoDir: string,
  ref: string,
): Promise<{ config: ProjectConfig; commit: string }> {
  const commit = (await git(repoDir, ["rev-parse", `${ref}^{commit}`])).trim();
  const text = await showFile(repoDir, commit, PROJECT_CONFIG_PATH);
  if (text === null) {
    throw new Error(
      `${PROJECT_CONFIG_PATH} not found at ${ref} (${commit.slice(0, 12)}) in ${repoDir}`,
    );
  }
  return {
    config: parseProjectConfig(text, `${PROJECT_CONFIG_PATH}@${commit.slice(0, 12)}`),
    commit,
  };
}

/** The conventions file as committed at `commit` (not from the worktree). */
export async function readConventions(
  repoDir: string,
  commit: string,
  file: string,
): Promise<string> {
  return (await showFile(repoDir, commit, file)) ?? "(The repository has no conventions file.)";
}
