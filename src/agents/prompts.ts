import { readFile } from "node:fs/promises";
import path from "node:path";
import { FACTORY_ROOT } from "../paths.js";
import type { AgentRole } from "../runtimes/types.js";
import type { TaskContent } from "../schemas/task.js";

export const PROMPTS_DIR = path.join(FACTORY_ROOT, "prompts");

/**
 * System prompt for a role: the role's instructions plus the target repository's
 * conventions. Conventions are injected by the factory because the runtime runs with
 * all settings sources disabled (no CLAUDE.md auto-loading).
 */
export async function buildSystemPrompt(role: AgentRole, conventions: string): Promise<string> {
  const rolePrompt = await readFile(path.join(PROMPTS_DIR, `${role}.md`), "utf8");
  return [
    rolePrompt.trim(),
    "## Repository conventions",
    "The target repository's own conventions file follows. Treat it as authoritative.",
    "<repository_conventions>",
    conventions.trim(),
    "</repository_conventions>",
  ].join("\n\n");
}

export function renderTask(task: TaskContent): string {
  return [
    `## Task: ${task.title} (\`${task.id}\`)`,
    "### Request",
    task.request.trim(),
    "### Acceptance criteria",
    task.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n"),
    "### Allowed paths",
    "Only files matching these globs may be changed:",
    task.scope.allowed_paths.map((p) => `- \`${p}\``).join("\n"),
  ].join("\n\n");
}

/**
 * The approved OpenSpec change as prompt text (files from the spec commit). It is the
 * primary source of requirements for the developer and the yardstick for the reviewer.
 */
export function renderSpecForPrompt(files: Readonly<Record<string, string>>): string {
  const body = Object.entries(files)
    .filter(([p]) => p.endsWith(".md"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, content]) => `### \`${p}\`\n\n${content.trim()}`)
    .join("\n\n");
  return [
    "## Approved specification (OpenSpec change)",
    "This specification was approved before implementation. It is the primary source of requirements; the acceptance criteria above must also hold. The files under `openspec/` are read-only: never edit them.",
    body,
  ].join("\n\n");
}
