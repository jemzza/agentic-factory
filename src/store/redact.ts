/** Replacement for secret values in logs, events and reports. */
export const MASK = "***";

/** Secrets shorter than this are not masked (would mangle ordinary text). */
const MIN_SECRET_LENGTH = 8;

export type Redactor = (text: string) => string;

/**
 * Builds a function that replaces every occurrence of the given secret values with `***`.
 * Longer secrets are replaced first so a secret containing another is fully masked.
 */
export function createRedactor(secrets: readonly (string | undefined)[]): Redactor {
  const values = [
    ...new Set(secrets.filter((s): s is string => !!s && s.length >= MIN_SECRET_LENGTH)),
  ].sort((a, b) => b.length - a.length);
  if (values.length === 0) return (text) => text;
  return (text) => values.reduce((acc, secret) => acc.split(secret).join(MASK), text);
}

/** Secret values from the environment, by variable name (e.g. the reviewer's provider key). */
export function secretsFromEnv(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return names.map((n) => env[n]).filter((v): v is string => typeof v === "string" && v !== "");
}
