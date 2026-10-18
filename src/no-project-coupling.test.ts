import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FACTORY_ROOT } from "./paths.js";

/**
 * The factory knows no project: every path, command and rule of a project comes from
 * projects.yaml and the project's own .factory/config.yaml. The eval stand's project may be
 * named only in fixtures/, evals/, the configs, docs, and the migration that assigns the
 * pre-project history to it. Tests are allowed to use it as data.
 */
const SCANNED = ["src", "scripts", "prompts", "sandbox", "factory.config.ts", "package.json"];
// Built from parts so this file does not match itself.
const STAND_NAME = new RegExp(["task", "flow"].join(""), "i");

async function files(rel: string): Promise<string[]> {
  const abs = path.join(FACTORY_ROOT, rel);
  const entries = await readdir(abs, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [rel];
  const out: string[] = [];
  for (const e of entries) {
    const child = path.posix.join(rel, e.name);
    if (e.isDirectory()) out.push(...(await files(child)));
    else out.push(child);
  }
  return out;
}

describe("no project coupling in factory code", () => {
  it("names the eval stand's project nowhere outside fixtures, evals, configs and tests", async () => {
    const offenders: string[] = [];
    for (const root of SCANNED) {
      for (const file of await files(root)) {
        if (file.endsWith(".test.ts") || file.includes("__fixtures__")) continue;
        const lines = (await readFile(path.join(FACTORY_ROOT, file), "utf8")).split("\n");
        lines.forEach((line, i) => {
          if (STAND_NAME.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
