import { ForbiddenMemoryError, MEMORY_SOURCES, type NewMemory } from "./types.js";

/** A memory record is a short rule, not a document. */
export const MAX_MEMORY_CHARS = 500;

/*
 * What never goes into memory, whatever the caller says: hidden tests and their results,
 * reference implementations, anything under evals/hidden or evals/reference, raw agent logs,
 * secrets, and text from GitHub users who are not allowed. Checked on every write.
 */
const HIDDEN_MARKERS: readonly RegExp[] = [
  /evals\/(hidden|reference)\b/i,
  /__hidden__/,
  /\.hidden\.test\.ts\b/,
  /\bhidden[ _-]?tests?\b/i,
  /\breference (patch|implementation)\b/i,
  /\bverify-hidden\b/i,
];
const RAW_LOG = [/^\s*\{"type":\s*"/m, /^diff --git /m, /^@@ -\d+,\d+ \+\d+,\d+ @@/m];
const SECRET_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function assertWritable(m: NewMemory, secretValues: readonly string[] = []): void {
  if (!MEMORY_SOURCES.includes(m.source))
    throw new ForbiddenMemoryError(`unknown source ${m.source}`);
  if (m.origin.kind === "github" && !m.origin.allowed) {
    throw new ForbiddenMemoryError(`text from ${m.origin.login}, who is not an allowed user`);
  }
  if (m.source === "spec_rejection_comment" && m.origin.kind === "factory") {
    throw new ForbiddenMemoryError("a rejection rule must come from a human decision");
  }
  const text = m.text.trim();
  if (text === "") throw new ForbiddenMemoryError("empty text");
  if (text.length > MAX_MEMORY_CHARS) {
    throw new ForbiddenMemoryError(
      `longer than ${MAX_MEMORY_CHARS} characters (a rule, not a document)`,
    );
  }
  if (HIDDEN_MARKERS.some((re) => re.test(text))) {
    throw new ForbiddenMemoryError("it refers to hidden tests or reference implementations");
  }
  if (RAW_LOG.some((re) => re.test(text)))
    throw new ForbiddenMemoryError("it looks like a raw log or diff");
  if (
    SECRET_SHAPES.some((re) => re.test(text)) ||
    secretValues.some((v) => v.length >= 8 && text.includes(v))
  ) {
    throw new ForbiddenMemoryError("it contains a secret");
  }
}
