import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { EVALS_DIR } from "../paths.js";

export const REVIEW_DIR = path.join(EVALS_DIR, "review");
export const REVIEW_CASES_DIR = path.join(REVIEW_DIR, "cases");

export const ReviewCaseSchema = z
  .strictObject({
    id: z.string().regex(/^[cd]\d{2}-[a-z0-9-]+$/),
    task: z.string().min(1),
    kind: z.enum(["clean", "defect"]),
    gate_passes: z.boolean(),
    hidden_tests_fail: z.boolean(),
    defect: z
      .strictObject({
        category: z.string().min(1),
        description: z.string().min(1),
        files: z.array(z.string().min(1)).min(1),
      })
      .optional(),
  })
  .refine((c) => (c.kind === "defect") === (c.defect !== undefined), {
    message: "defect cases need a `defect` block, clean cases must not have one",
  });
export type ReviewCase = z.infer<typeof ReviewCaseSchema> & { patchPath: string };

export async function loadReviewCases(dir: string = REVIEW_CASES_DIR): Promise<ReviewCase[]> {
  const ids = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const cases: ReviewCase[] = [];
  for (const id of ids) {
    const raw: unknown = parseYaml(await readFile(path.join(dir, id, "case.yaml"), "utf8"));
    const parsed = ReviewCaseSchema.parse(raw);
    if (parsed.id !== id)
      throw new Error(`case ${id}: id "${parsed.id}" does not match its directory`);
    cases.push({ ...parsed, patchPath: path.join(dir, id, "change.patch") });
  }
  return cases;
}

/** Checks every case file against MANIFEST.sha256 (`shasum -a 256` format). */
export async function verifyManifest(reviewDir: string = REVIEW_DIR): Promise<string[]> {
  const manifest = await readFile(path.join(reviewDir, "MANIFEST.sha256"), "utf8");
  const problems: string[] = [];
  const listed = new Set<string>();
  for (const line of manifest.split("\n").filter((l) => l.trim() !== "")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line);
    if (!m?.[1] || !m[2]) {
      problems.push(`bad manifest line: ${line}`);
      continue;
    }
    listed.add(m[2]);
    const actual = createHash("sha256")
      .update(await readFile(path.join(reviewDir, m[2])).catch(() => Buffer.from("<missing>")))
      .digest("hex");
    if (actual !== m[1]) problems.push(`${m[2]} differs from the manifest`);
  }
  async function walk(rel: string): Promise<void> {
    for (const e of await readdir(path.join(reviewDir, rel), { withFileTypes: true })) {
      const p = path.posix.join(rel, e.name);
      if (e.isDirectory()) await walk(p);
      else if (!listed.has(p)) problems.push(`${p} is not in the manifest`);
    }
  }
  await walk("cases");
  return problems;
}
