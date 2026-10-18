import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FACTORY_ROOT } from "../paths.js";
import { ProjectRegistrySchema } from "../schemas/project.js";
import { DEMO_MARKER, demoRegistryYaml, demoRootProblem, resetDemo } from "./demo-env.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-demo-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const guard = () => ({
  factoryRoot: FACTORY_ROOT,
  workdir: path.join(tmp, "working-workdir"),
  home: path.join(tmp, "home"),
});

describe("demo sandbox", () => {
  it("refuses roots that could hold real data", () => {
    const g = guard();
    expect(demoRootProblem("/", g)).toMatch(/filesystem root/);
    expect(demoRootProblem(g.home, g)).toMatch(/home/);
    expect(demoRootProblem(path.join(FACTORY_ROOT, "demo"), g)).toMatch(/repository/);
    expect(demoRootProblem(path.join(g.workdir, "demo"), g)).toMatch(/FACTORY_WORKDIR/);
    expect(demoRootProblem(tmp, g)).toMatch(/FACTORY_WORKDIR/); // would contain it
    expect(demoRootProblem(path.join(tmp, "demo"), g)).toBeNull();
  });

  it("creates its own database path, workdir, runs and registry, and wipes only a marked root", async () => {
    const root = path.join(tmp, "demo");
    const p = await resetDemo(root, { owner: "octo-owner", ...guard() });
    const env = await readFile(p.envFile, "utf8");
    expect(env).toContain(`FACTORY_DB=${path.join(root, "factory.db")}`);
    expect(env).toContain(`FACTORY_WORKDIR=${path.join(root, "work")}`);
    expect(env).toContain(`FACTORY_RUNS=${path.join(root, "runs")}`);
    expect(env).toContain(`FACTORY_PROJECTS=${path.join(root, "projects.yaml")}`);
    expect(env).not.toContain(path.join(FACTORY_ROOT, "data"));
    // A second reset wipes the sandbox (leftovers disappear).
    await writeFile(path.join(p.workdir, "leftover"), "x");
    await resetDemo(root, { owner: null, ...guard() });
    await expect(readFile(path.join(p.workdir, "leftover"))).rejects.toThrow();
    await expect(readFile(path.join(root, DEMO_MARKER), "utf8")).resolves.toContain("demo");
    // An existing directory without the marker is never touched.
    const foreign = path.join(tmp, "foreign");
    await mkdir(foreign);
    await writeFile(path.join(foreign, "keep.txt"), "mine");
    await expect(resetDemo(foreign, { owner: null, ...guard() })).rejects.toThrow(
      /not a demo root/,
    );
    await expect(readFile(path.join(foreign, "keep.txt"), "utf8")).resolves.toBe("mine");
  });

  it("writes a valid registry: the owner's two GitHub test repos, or a copy of the working one", async () => {
    const sources = {
      template: await readFile(path.join(FACTORY_ROOT, "projects.demo.yaml"), "utf8"),
      working: await readFile(path.join(FACTORY_ROOT, "projects.yaml"), "utf8"),
    };
    const withOwner = ProjectRegistrySchema.parse(
      parseYaml(demoRegistryYaml("octo-owner", sources)),
    );
    expect(withOwner.projects.map((p) => [p.id, p.github?.repo, p.allowed_users])).toEqual([
      ["taskflow-demo", "octo-owner/taskflow-demo", ["octo-owner"]],
      ["ledgerlite", "octo-owner/ledgerlite", ["octo-owner"]],
    ]);
    const local = ProjectRegistrySchema.parse(parseYaml(demoRegistryYaml(null, sources)));
    expect(local.projects.every((p) => p.github === null && p.source.kind === "fixture")).toBe(
      true,
    );
    expect(local.projects.length).toBeGreaterThan(0);
    expect(() => demoRegistryYaml("bad login; rm -rf", sources)).toThrow(/invalid GitHub login/);
  });
});
