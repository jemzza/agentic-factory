import type { AgentRole } from "./types.js";

/** Tools that can only read files inside the working directory. */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

/** Tools the developer may use; `Bash` only with an explicit command specifier. */
const DEVELOPER_TOOLS = new Set(["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);

/**
 * Default developer tool set: edit files and run the project's own checks.
 * Bash rules are exact commands, no wildcards: e.g. `git diff *` would admit
 * `git diff --output=<path outside the worktree>`.
 */
export const DEVELOPER_DEFAULT_TOOLS = [
  ...READ_ONLY_TOOLS,
  "Edit",
  "Write",
  "Bash(npm run check)",
  "Bash(npm run typecheck)",
  "Bash(npm test)",
  "Bash(npm run test)",
  "Bash(git status)",
  "Bash(git diff)",
];

/**
 * Files no agent may touch, even inside the worktree. Expressed as Claude Code
 * permission rules (gitignore-style paths relative to the working directory).
 */
export const SECRET_PATH_PATTERNS = ["./.env*", "./**/.env*", "./**/*.pem", "./**/*.key"];

const SPEC = /^([A-Za-z]+)(?:\((.+)\))?$/;

export interface ParsedTool {
  name: string;
  specifier?: string;
}

export function parseToolEntry(entry: string): ParsedTool {
  const m = SPEC.exec(entry.trim());
  if (!m?.[1]) throw new Error(`Invalid tool entry "${entry}"`);
  return m[2] === undefined ? { name: m[1] } : { name: m[1], specifier: m[2] };
}

/**
 * Enforces the per-role tool policy. Throws on violation: a bad tool list is a factory
 * bug, not an agent failure.
 */
export function assertToolsAllowed(role: AgentRole, allowedTools: readonly string[]): void {
  if (allowedTools.length === 0) throw new Error(`${role}: allowedTools must not be empty`);
  for (const entry of allowedTools) {
    const tool = parseToolEntry(entry);
    if (role === "planner" || role === "reviewer") {
      if (!(READ_ONLY_TOOLS as readonly string[]).includes(tool.name) || tool.specifier) {
        throw new Error(
          `${role} may only use read-only tools (${READ_ONLY_TOOLS.join(", ")}); got "${entry}"`,
        );
      }
      continue;
    }
    if (!DEVELOPER_TOOLS.has(tool.name)) {
      throw new Error(`developer may not use tool "${entry}"`);
    }
    if (tool.name === "Bash" && tool.specifier === undefined) {
      throw new Error('developer: bare "Bash" would allow any command; use Bash(<command>)');
    }
    if (tool.name === "Bash" && tool.specifier?.includes("*")) {
      throw new Error(`developer: wildcard Bash rules are not allowed; got "${entry}"`);
    }
    if (tool.specifier !== undefined && tool.name !== "Bash") {
      throw new Error(
        `developer: path-scoped "${entry}" is not supported; file tools are confined to the worktree`,
      );
    }
  }
}
