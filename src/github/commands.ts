/**
 * Commands in GitHub comments. GitHub is an untrusted input: a command counts only if
 * - the comment does not carry the factory's marker: the factory writes from the owner's
 *   account, so its own comments (which show the commands as hints) are never commands;
 * - the command starts the comment's first non-empty line (a quoted or mid-text "/approve"
 *   is not a command);
 * - its author is in the project's allowed_users (checked by the caller, before parsing).
 */

/** Hidden marker in every comment the factory writes (owner's decision, Week 3). */
export const BOT_MARKER = "<!-- factory:bot -->";

export type Command =
  | { kind: "approve"; hash: string | null }
  | { kind: "reject"; reason: string }
  | { kind: "merge" }
  | { kind: "close"; reason: string }
  | { kind: "retry" };

export type ParsedCommand = { ok: true; command: Command } | { ok: false; error: string } | null;

export function isFactoryComment(body: string): boolean {
  return body.includes(BOT_MARKER);
}

/**
 * The command in a comment, an error for a malformed one (e.g. `/reject` without a reason),
 * or null if the comment is not a command at all.
 */
export function parseCommand(body: string): ParsedCommand {
  if (isFactoryComment(body)) return null;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const firstIndex = lines.findIndex((l) => l.trim() !== "");
  if (firstIndex === -1) return null;
  const first = lines[firstIndex] ?? "";
  const m = /^\/(approve|reject|merge|close|retry)(?:\s+(.*))?$/.exec(first.trimEnd());
  if (!m) return null;
  // The reason may continue on the following lines.
  const rest = [m[2] ?? "", ...lines.slice(firstIndex + 1)].join("\n").trim();
  const name = m[1] as "approve" | "reject" | "merge" | "close" | "retry";
  switch (name) {
    case "approve":
      if (rest === "") return { ok: true, command: { kind: "approve", hash: null } };
      return /^[0-9a-f]{12}$/.test(rest)
        ? { ok: true, command: { kind: "approve", hash: rest } }
        : { ok: false, error: "`/approve` takes no argument, or the 12-character spec hash" };
    case "reject":
      return rest
        ? { ok: true, command: { kind: "reject", reason: rest } }
        : { ok: false, error: "`/reject` needs a reason: `/reject <what to change>`" };
    case "close":
      return rest
        ? { ok: true, command: { kind: "close", reason: rest } }
        : { ok: false, error: "`/close` needs a reason: `/close <why not merged>`" };
    case "merge":
      return rest === ""
        ? { ok: true, command: { kind: "merge" } }
        : { ok: false, error: "`/merge` takes no argument" };
    case "retry":
      return rest === ""
        ? { ok: true, command: { kind: "retry" } }
        : { ok: false, error: "`/retry` takes no argument" };
  }
}

/** Exact, case-insensitive login match (GitHub logins are case-insensitive). */
export function isAllowed(login: string, allowed: readonly string[]): boolean {
  const l = login.toLowerCase();
  return allowed.some((a) => a.toLowerCase() === l);
}

/**
 * Version binding: an `/approve` (or `/reject`) applies only to the latest published spec
 * version, and only if it was written after that version was published. A comment edited
 * later is judged by its creation time and its body as first seen.
 */
export function specCommandApplies(
  commentCreatedAt: string,
  latest: { publishedAt: string; hash: string },
  hash: string | null,
): { ok: true } | { ok: false; reason: string } {
  if (Date.parse(commentCreatedAt) <= Date.parse(latest.publishedAt)) {
    return {
      ok: false,
      reason: `it was written before the current specification (hash ${latest.hash}) was published`,
    };
  }
  if (hash !== null && hash !== latest.hash) {
    return { ok: false, reason: `hash ${hash} is not the current specification (${latest.hash})` };
  }
  return { ok: true };
}
