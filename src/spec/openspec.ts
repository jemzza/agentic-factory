import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { FACTORY_ROOT } from "../paths.js";
import { runCommand } from "../process/run-command.js";
import { OpenSpecIssueSchema, type OpenSpecIssue, type SpecChange } from "../schemas/spec.js";

/*
 * OpenSpec 1.14.2 CLI, run by the factory (never by agents). Behavior verified in Phase 0:
 * - `openspec validate <id> --strict --json --no-interactive` → exit 0 when valid, exit 1
 *   otherwise; stdout {items:[{id, type, valid, issues:[{level, path?, line?, message}]}], …}.
 * - `openspec archive <id> -y --json` → moves the change to changes/archive/<date>-<id>/ and
 *   merges deltas into openspec/specs/; a repeated call fails with archive_change_not_found.
 * Telemetry and update checks are disabled through the environment on every call.
 */

export const OPENSPEC_BIN = path.join(FACTORY_ROOT, "node_modules", ".bin", "openspec");
const TIMEOUT_MS = 60_000;

function openspecEnv(): Record<string, string> {
  const env: Record<string, string> = {
    OPENSPEC_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
    OPENSPEC_NO_UPDATE_CHECK: "1",
    OPENSPEC_NO_ANIMATION: "1",
    OPENSPEC_NO_COMPLETIONS: "1",
    NO_COLOR: "1",
  };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG"]) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

export const changeDir = (changeId: string) => path.posix.join("openspec", "changes", changeId);

/** Single-line field (names): newlines would break Markdown headers. */
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
/** Body text: keep paragraphs, but never let a line become a Markdown header. */
const block = (s: string) =>
  s
    .trim()
    .split("\n")
    .map((l) => l.replace(/^(\s*)#/, "$1\\#"))
    .join("\n");

/**
 * Renders a structured spec into OpenSpec files (repo-relative path → content).
 * Pure and deterministic: the same spec and date always give the same bytes.
 */
export function renderSpecFiles(
  changeId: string,
  spec: SpecChange,
  createdDate: string,
): Record<string, string> {
  const dir = changeDir(changeId);
  const capLine = (c: SpecChange["capabilities"][number]) =>
    `- \`${c.path}\`: ${oneLine(c.purpose || c.requirements.map((r) => r.name).join(", "))}`;
  const newCaps = spec.capabilities.filter((c) => c.kind === "new");
  const modCaps = spec.capabilities.filter((c) => c.kind === "modified");

  const proposal = [
    "# Proposal",
    "## Why",
    block(spec.why),
    "## What Changes",
    spec.what_changes.map((w) => `- ${oneLine(w)}`).join("\n"),
    "## Capabilities",
    "### New Capabilities",
    newCaps.length ? newCaps.map(capLine).join("\n") : "(none)",
    "### Modified Capabilities",
    modCaps.length ? modCaps.map(capLine).join("\n") : "(none)",
    "## Impact",
    block(spec.impact),
  ].join("\n\n");

  const files: Record<string, string> = {
    [`${dir}/.openspec.yaml`]: `schema: spec-driven\ncreated: ${createdDate}\n`,
    [`${dir}/proposal.md`]: `${proposal}\n`,
    [`${dir}/tasks.md`]: `## 1. Implementation\n\n${spec.tasks
      .map((t, i) => `- [ ] 1.${i + 1} ${oneLine(t)}`)
      .join("\n")}\n`,
  };

  for (const cap of spec.capabilities) {
    const parts: string[] = [];
    if (cap.kind === "new") parts.push("## Purpose", block(cap.purpose));
    parts.push("## ADDED Requirements");
    for (const req of cap.requirements) {
      parts.push(`### Requirement: ${oneLine(req.name)}\n${block(req.text)}`);
      for (const sc of req.scenarios) {
        parts.push(
          `#### Scenario: ${oneLine(sc.name)}\n- **WHEN** ${oneLine(sc.when)}\n- **THEN** ${oneLine(sc.then)}`,
        );
      }
    }
    files[`${dir}/specs/${cap.path}/spec.md`] = `${parts.join("\n\n")}\n`;
  }
  return files;
}

/** Replaces the change directory in `repoDir` with exactly `files`. */
export async function writeSpecFiles(
  repoDir: string,
  changeId: string,
  files: Record<string, string>,
): Promise<void> {
  await rm(path.join(repoDir, changeDir(changeId)), { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repoDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

const ValidateOutputSchema = z.looseObject({
  items: z.array(
    z.looseObject({ id: z.string(), valid: z.boolean(), issues: z.array(OpenSpecIssueSchema) }),
  ),
});

export type ValidationResult =
  | { kind: "valid"; issues: OpenSpecIssue[] }
  | { kind: "invalid"; issues: OpenSpecIssue[] }
  /** The validator itself could not run or produced unreadable output. */
  | { kind: "error"; message: string };

export async function validateChange(repoDir: string, changeId: string): Promise<ValidationResult> {
  const res = await runCommand(
    OPENSPEC_BIN,
    ["validate", changeId, "--type", "change", "--strict", "--json", "--no-interactive"],
    { cwd: repoDir, timeoutMs: TIMEOUT_MS, env: openspecEnv() },
  );
  if (res.spawnError || res.timedOut) {
    return { kind: "error", message: res.spawnError ?? "openspec validate timed out" };
  }
  let json: unknown;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    return {
      kind: "error",
      message: `openspec validate printed no JSON (exit ${res.exitCode ?? "?"}): ${res.stderr.slice(0, 500)}`,
    };
  }
  const parsed = ValidateOutputSchema.safeParse(json);
  const item = parsed.success ? parsed.data.items.find((i) => i.id === changeId) : undefined;
  if (!item)
    return {
      kind: "error",
      message: `unexpected openspec validate output: ${res.stdout.slice(0, 500)}`,
    };
  if (item.valid && res.exitCode === 0) return { kind: "valid", issues: item.issues };
  return { kind: "invalid", issues: item.issues };
}

const ArchiveOutputSchema = z.looseObject({
  archive: z.looseObject({ archivedAs: z.string() }).nullable(),
});

/**
 * Archives an approved, merged change. Idempotent: if the change is already archived
 * (changes/archive/<date>-<id>) its archive name is returned without calling the CLI again.
 */
export async function archiveChange(
  repoDir: string,
  changeId: string,
): Promise<{ archivedAs: string }> {
  const archiveDir = path.join(repoDir, "openspec", "changes", "archive");
  const existing = (await readdir(archiveDir).catch(() => [])).find((d) =>
    d.endsWith(`-${changeId}`),
  );
  if (existing) return { archivedAs: existing };
  const res = await runCommand(OPENSPEC_BIN, ["archive", changeId, "-y", "--json"], {
    cwd: repoDir,
    timeoutMs: TIMEOUT_MS,
    env: openspecEnv(),
  });
  let json: unknown = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    // handled below
  }
  const parsed = ArchiveOutputSchema.safeParse(json);
  if (res.exitCode !== 0 || !parsed.success || !parsed.data.archive) {
    throw new Error(
      `openspec archive ${changeId} failed (exit ${res.exitCode ?? "?"}): ${res.stdout.slice(0, 500)} ${res.stderr.slice(0, 500)}`,
    );
  }
  return { archivedAs: parsed.data.archive.archivedAs };
}

/** Human-readable issues for the planner's fix attempt and for reports. */
export function describeIssues(issues: readonly OpenSpecIssue[]): string {
  return issues
    .map((i) =>
      `- [${i.level}] ${i.path ?? ""}${i.line !== undefined ? `:${i.line}` : ""} ${i.message}`.trim(),
    )
    .join("\n");
}
