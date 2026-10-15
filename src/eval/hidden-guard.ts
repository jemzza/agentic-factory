import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { HIDDEN_DIR, REFERENCE_DIR } from "../paths.js";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push(full);
    }
  }
  await walk(root);
  return out;
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Fingerprints (content hashes and file names) of everything agents must never see. */
export async function protectedFingerprints(
  dirs: readonly string[] = [HIDDEN_DIR, REFERENCE_DIR],
): Promise<{ hashes: Set<string>; names: Set<string> }> {
  const hashes = new Set<string>();
  const names = new Set<string>();
  for (const dir of dirs) {
    for (const file of await listFiles(dir)) {
      hashes.add(sha(await readFile(file)));
      const base = path.basename(file);
      if (base !== "meta.yaml") names.add(base);
    }
  }
  return { hashes, names };
}

/**
 * Returns worktree files that match a hidden test / reference patch by content or by name,
 * plus any `__hidden__` directory. Must be empty for every agent worktree.
 */
export async function findHiddenArtifacts(
  worktree: string,
  fingerprints?: { hashes: Set<string>; names: Set<string> },
): Promise<string[]> {
  const fp = fingerprints ?? (await protectedFingerprints());
  const hits: string[] = [];
  for (const file of await listFiles(worktree)) {
    const rel = path.relative(worktree, file);
    if (
      rel.split(path.sep).includes("__hidden__") ||
      fp.names.has(path.basename(file)) ||
      fp.hashes.has(sha(await readFile(file)))
    ) {
      hits.push(rel);
    }
  }
  return hits;
}
