import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { z } from "zod";
import { FACTORY_ROOT } from "../paths.js";
import { FactoryConfigSchema, roleBindingIssues, type FactoryConfig } from "../schemas/config.js";

export const CONFIG_FILE = path.join(FACTORY_ROOT, "factory.config.ts");

/** The config file in use: `FACTORY_CONFIG` (relative to the factory root) or the default. */
export function configFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["FACTORY_CONFIG"];
  return override ? path.resolve(FACTORY_ROOT, override) : CONFIG_FILE;
}

/** What factory.config.ts exports (input shape: defaults may be omitted). */
export type FactoryConfigInput = z.input<typeof FactoryConfigSchema>;

export function expandHome(p: string, home: string = os.homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

export interface ResolvedConfig extends FactoryConfig {
  /** Absolute workdir (after `~` expansion and the FACTORY_WORKDIR override). */
  workdirAbs: string;
  /** Model per role, derived from `roles` (kept for reports and callers that need only it). */
  models: Record<"planner" | "developer" | "reviewer", string>;
}

export function resolveConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
  source = "config",
): ResolvedConfig {
  const parsed = FactoryConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${source}: ${parsed.error.message}`);
  const issues = roleBindingIssues(parsed.data);
  if (issues.length) throw new Error(`Invalid ${source}:\n- ${issues.join("\n- ")}`);
  const workdirAbs = path.resolve(expandHome(env["FACTORY_WORKDIR"] ?? parsed.data.workdir));
  assertOutside(workdirAbs, FACTORY_ROOT);
  const r = parsed.data.roles;
  return {
    ...parsed.data,
    workdirAbs,
    models: { planner: r.planner.model, developer: r.developer.model, reviewer: r.reviewer.model },
  };
}

/**
 * Loads and validates the factory config. `FACTORY_WORKDIR` overrides `workdir`.
 * The workdir must be outside the factory repository: agents work there, and nothing
 * from evals/ (hidden tests, reference patches) may be reachable from it.
 */
export async function loadConfig(
  file: string = configFile(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedConfig> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  return resolveConfig(mod.default, env, file);
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
