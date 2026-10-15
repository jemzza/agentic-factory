import type { ScopeResult } from "../schemas/report.js";

/**
 * Converts a path glob to a RegExp. Supported: `**` (any number of path segments),
 * `*` (anything except `/`), `?` (one character except `/`). Paths are repo-relative
 * with forward slashes.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(file: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(file));
}

/** Every changed file (added, modified, or deleted) must fall within `allowedPaths`. */
export function checkScope(
  changed: readonly string[],
  allowedPaths: readonly string[],
): ScopeResult {
  const violations = changed.filter((f) => !matchesAny(f, allowedPaths));
  const empty = changed.length === 0;
  return {
    passed: violations.length === 0 && !empty,
    changedFiles: [...changed],
    violations,
    empty,
  };
}
