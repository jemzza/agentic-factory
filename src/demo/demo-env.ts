import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ProjectRegistrySchema } from "../schemas/project.js";

/*
 * The demo runs in its own sandbox, never in the working data (Week 3 Phase 8):
 *   <root>/.factory-demo   marker: only a directory with it may be wiped
 *   <root>/factory.db      FACTORY_DB        (the working data/factory.db is never opened)
 *   <root>/work/           FACTORY_WORKDIR   (clones, worktrees, Pi agent dir)
 *   <root>/runs/           FACTORY_RUNS
 *   <root>/projects.yaml   FACTORY_PROJECTS  (from projects.demo.yaml: the owner's GitHub test repos)
 *   <root>/demo.env        the variables above, read by `npm run demo -- <command>`
 * GitHub is not touched by a reset: no force-push, no deleted issues. The demo repositories are
 * dedicated test repositories, and each demo opens a new issue.
 */

export const DEMO_MARKER = ".factory-demo";
export const DEFAULT_DEMO_ROOT = path.join(os.homedir(), "agentic-factory-demo");

export interface DemoPaths {
  root: string;
  db: string;
  workdir: string;
  runs: string;
  registry: string;
  envFile: string;
}

export function demoPaths(root: string): DemoPaths {
  const r = path.resolve(root);
  return {
    root: r,
    db: path.join(r, "factory.db"),
    workdir: path.join(r, "work"),
    runs: path.join(r, "runs"),
    registry: path.join(r, "projects.yaml"),
    envFile: path.join(r, "demo.env"),
  };
}

const within = (parent: string, child: string) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Refuses a root that could hold real data: the repo, the working workdir, home, `/`. */
export function demoRootProblem(
  root: string,
  guard: { factoryRoot: string; workdir: string; home: string },
): string | null {
  const r = path.resolve(root);
  if (r === path.parse(r).root) return "the filesystem root";
  if (r === path.resolve(guard.home)) return "the home directory";
  if (within(guard.factoryRoot, r) || within(r, guard.factoryRoot))
    return "inside or around the factory repository";
  if (within(guard.workdir, r) || within(r, guard.workdir))
    return "inside or around the working FACTORY_WORKDIR";
  return null;
}

const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

/** The demo registry template (repository root) and the working registry. */
export const DEMO_REGISTRY_TEMPLATE = "projects.demo.yaml";

/**
 * The demo registry: the template with the owner's login (the owner's GitHub test
 * repositories), or, without a login, the fixture projects of the working registry (no GitHub
 * steps, never a real repository). Validated before it is written.
 */
export function demoRegistryYaml(
  owner: string | null,
  sources: { template: string; working: string },
): string {
  if (owner !== null && !LOGIN.test(owner)) throw new Error(`invalid GitHub login "${owner}"`);
  let text: string;
  if (owner === null) {
    // Fixture projects only: a git source there could be the owner's real repository, and a
    // demo merge would push to it.
    const working = ProjectRegistrySchema.parse(parseYaml(sources.working));
    const projects = working.projects.filter((p) => p.source.kind === "fixture");
    text =
      "# Demo registry without GitHub (no --owner): the fixture projects of projects.yaml.\n" +
      stringifyYaml({ version: 1, projects });
  } else {
    text = sources.template.replaceAll("__GITHUB_OWNER__", owner);
  }
  ProjectRegistrySchema.parse(parseYaml(text)); // never write a registry the factory refuses
  return text;
}

export function demoEnv(p: DemoPaths): Record<string, string> {
  return {
    FACTORY_DB: p.db,
    FACTORY_WORKDIR: p.workdir,
    FACTORY_RUNS: p.runs,
    FACTORY_PROJECTS: p.registry,
  };
}

const exists = async (f: string) => {
  try {
    await access(f);
    return true;
  } catch {
    return false;
  }
};

/** Wipes (only a marked demo root) and recreates the demo sandbox. */
export async function resetDemo(
  root: string,
  opts: { owner: string | null; factoryRoot: string; workdir: string; home: string },
): Promise<DemoPaths> {
  const registry = demoRegistryYaml(opts.owner, {
    template: await readFile(path.join(opts.factoryRoot, DEMO_REGISTRY_TEMPLATE), "utf8"),
    working: await readFile(path.join(opts.factoryRoot, "projects.yaml"), "utf8"),
  });
  const p = demoPaths(root);
  const problem = demoRootProblem(p.root, opts);
  if (problem) throw new Error(`refusing to use ${p.root} as the demo root: ${problem}`);
  if (await exists(p.root)) {
    if (!(await exists(path.join(p.root, DEMO_MARKER))))
      throw new Error(
        `${p.root} exists but is not a demo root (no ${DEMO_MARKER}); not touching it`,
      );
    await rm(p.root, { recursive: true, force: true });
  }
  await mkdir(p.workdir, { recursive: true });
  await mkdir(p.runs, { recursive: true });
  await writeFile(path.join(p.root, DEMO_MARKER), "Agentic Software Factory demo sandbox\n");
  await writeFile(p.registry, registry);
  await writeFile(
    p.envFile,
    Object.entries(demoEnv(p))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
  );
  return p;
}
