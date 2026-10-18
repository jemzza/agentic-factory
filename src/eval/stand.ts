import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  findProject,
  loadEvalConfig,
  loadRegistry,
  parseProjectConfig,
  PROJECT_CONFIG_PATH,
} from "../config/projects.js";
import type { ProjectSource } from "../git/target-repo.js";
import { FACTORY_ROOT } from "../paths.js";
import type { EvalConfig, ProjectConfig } from "../schemas/project.js";

/** Everything eval needs about its stand (evals/eval.config.yaml + the project's config). */
export interface EvalStand {
  /** The project as eval materializes it: the stand's own source, never a remote. */
  project: ProjectSource;
  /** Absolute path of the fixture directory (verify-hidden and eval:review copy it). */
  fixtureDir: string;
  /** The project's .factory/config.yaml as committed in the fixture. */
  projectConfig: ProjectConfig;
  hidden: EvalConfig["hidden_tests"];
}

export async function loadEvalStand(): Promise<EvalStand> {
  const evalConfig = await loadEvalConfig();
  findProject(await loadRegistry(), evalConfig.project); // the stand must be a registered project
  if (evalConfig.source.kind !== "fixture") {
    throw new Error("evals/eval.config.yaml: the eval source must be a fixture (no remote)");
  }
  const fixtureDir = path.resolve(FACTORY_ROOT, evalConfig.source.path);
  const configFile = path.join(fixtureDir, PROJECT_CONFIG_PATH);
  return {
    project: { id: evalConfig.project, source: evalConfig.source },
    fixtureDir,
    projectConfig: parseProjectConfig(await readFile(configFile, "utf8"), configFile),
    hidden: evalConfig.hidden_tests,
  };
}
