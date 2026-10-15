import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { SandboxExec } from "../quality/gate.js";
import { tailLines } from "../quality/gate.js";
import { listHiddenTestFiles, type EvalDirs, DEFAULT_EVAL_DIRS } from "./tasks.js";
import { installHiddenTests, prepareTargetCopy } from "./target-copy.js";

export interface HiddenTestResult {
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Test counts from Vitest's JSON report; null if it could not be parsed. */
  total: number | null;
  failed: number | null;
  durationMs: number;
  outputTail: string;
  /** Sandbox infrastructure failure (the hidden tests did not actually run). */
  infraError?: string;
}

const VitestJsonSchema = z.looseObject({
  numTotalTests: z.number(),
  numFailedTests: z.number(),
  testResults: z
    .array(
      z.looseObject({
        message: z.string().optional(),
        assertionResults: z
          .array(
            z.looseObject({
              fullName: z.string(),
              status: z.string(),
              failureMessages: z.array(z.string()).optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

export interface VitestSummary {
  total: number;
  failed: number;
  /** One line per failed test (or suite error): name and first line of the message. */
  failures: string[];
}

/** Parses `vitest --reporter=json` stdout (may be surrounded by other output). */
export function parseVitestJson(stdout: string): VitestSummary | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let json: unknown;
  try {
    json = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = VitestJsonSchema.safeParse(json);
  if (!parsed.success) return null;
  const firstLine = (s: string) => s.split("\n")[0] ?? "";
  const failures: string[] = [];
  for (const file of parsed.data.testResults ?? []) {
    if (file.message) failures.push(`suite error: ${firstLine(file.message)}`);
    for (const a of file.assertionResults ?? []) {
      if (a.status === "failed") {
        failures.push(`✗ ${a.fullName}: ${firstLine(a.failureMessages?.[0] ?? "")}`);
      }
    }
  }
  return { total: parsed.data.numTotalTests, failed: parsed.data.numFailedTests, failures };
}

/**
 * Runs a task's hidden tests against the final state of an agent worktree.
 * The worktree itself is never modified: it is copied to a throwaway directory, the
 * hidden tests are added to the copy, and the copy is checked in the sandbox.
 * Pass/fail is the exit code; the JSON report only adds counts.
 */
export async function runHiddenTests(opts: {
  worktreePath: string;
  taskId: string;
  exec: SandboxExec;
  timeoutMs: number;
  dirs?: EvalDirs;
}): Promise<HiddenTestResult> {
  const files = await listHiddenTestFiles(opts.taskId, opts.dirs ?? DEFAULT_EVAL_DIRS);
  const root = await mkdtemp(path.join(os.tmpdir(), `factory-hidden-${opts.taskId}-`));
  try {
    const copy = path.join(root, "copy");
    await prepareTargetCopy({ source: opts.worktreePath, dest: copy });
    const hiddenDir = await installHiddenTests(copy, files);
    // Vitest 5 writes the JSON report to a file; print it after the run and keep
    // vitest's exit code. The hidden dir is passed as $1 (no shell interpolation).
    const script =
      'node_modules/.bin/vitest run --reporter=json --outputFile.json=/tmp/hidden-report.json "$1"; ' +
      "rc=$?; cat /tmp/hidden-report.json 2>/dev/null; exit $rc";
    const res = await opts.exec(copy, ["sh", "-c", script, "sh", hiddenDir], opts.timeoutMs);
    const counts = parseVitestJson(res.stdout);
    return {
      passed: res.infraError === undefined && res.exitCode === 0 && !res.timedOut,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      total: counts?.total ?? null,
      failed: counts?.failed ?? null,
      durationMs: res.durationMs,
      outputTail: counts
        ? counts.failures.slice(0, 40).join("\n")
        : tailLines(`${res.stdout}\n${res.stderr}`, 40),
      ...(res.infraError !== undefined ? { infraError: res.infraError } : {}),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
