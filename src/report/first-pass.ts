import { readFile, writeFile } from "node:fs/promises";
import { RunReportSchema } from "../schemas/report.js";
import { renderReportMarkdown } from "./markdown.js";

/**
 * Writes the eval's first-pass decision into a finished run's report.json / report.md.
 * The pipeline cannot know it (hidden tests run after the report), so it writes null.
 */
export async function writeFirstPass(
  paths: { reportJsonPath: string; reportMdPath: string },
  firstPass: boolean | null,
): Promise<void> {
  const report = RunReportSchema.parse(
    JSON.parse(await readFile(paths.reportJsonPath, "utf8")) as unknown,
  );
  const updated = { ...report, firstPass };
  await writeFile(paths.reportJsonPath, JSON.stringify(updated, null, 2));
  await writeFile(paths.reportMdPath, renderReportMarkdown(updated));
}
