import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FACTORY_ROOT } from "../paths.js";
import { FactoryConfigSchema, type FactoryConfig } from "../schemas/config.js";

export const CONFIG_FILE = path.join(FACTORY_ROOT, "factory.config.json");

export function expandHome(p: string, home: string = os.homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

export interface ResolvedConfig extends FactoryConfig {
  /** Absolute workdir (after `~` expansion and the FACTORY_WORKDIR override). */
  workdirAbs: string;
}

/**
 * Loads and validates the factory config. `FACTORY_WORKDIR` overrides `workdir`.
 * The workdir must be outside the factory repository: agents work there, and nothing
 * from evals/ (hidden tests, reference patches) may be reachable from it.
 */
export async function loadConfig(
  file: string = CONFIG_FILE,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedConfig> {
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  const parsed = FactoryConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${file}: ${parsed.error.message}`);
  const workdirAbs = path.resolve(expandHome(env["FACTORY_WORKDIR"] ?? parsed.data.workdir));
  assertOutside(workdirAbs, FACTORY_ROOT);
  return { ...parsed.data, workdirAbs };
}

export function assertOutside(workdir: string, factoryRoot: string): void {
  const rel = path.relative(factoryRoot, workdir);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  const contains = !path.relative(workdir, factoryRoot).startsWith("..");
  if (inside || contains) {
    throw new Error(
      `workdir ${workdir} must not be inside (or contain) the factory repository ${factoryRoot}`,
    );
  }
}
