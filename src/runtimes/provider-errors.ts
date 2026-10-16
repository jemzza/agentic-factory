/*
 * The one place that decides "the model provider refused the call" (subscription usage limit,
 * API rate limit, overload, outage). Such a step error has kind `infra`, the run ends as
 * `infra_error`, and evals leave it out of every quality metric.
 *
 * Recorded evidence (Claude Code 2.1.300, 2026-10-16, subscription session limit), the `result`
 * event of a real stream-json log (src/runtimes/__fixtures__/live-result-events-2.1.300.json):
 *   {"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error",
 *    "api_error_status":429,"api_error":"usage_limit_reached",
 *    "result":"You've hit your session limit · resets 7:10pm (Europe/Moscow)", ...}  exit code 1
 * Also recorded: informational {"type":"rate_limit_event","rate_limit_info":{"status":"allowed",
 * ...}} lines in successful runs. They are not errors and are never matched here.
 *
 * Not recorded live (no sample in any log so far): a plain API 429 rate limit, 529 overload,
 * 5xx, or a network failure. They are covered by the documented API error types / HTTP status
 * classes and by Node's network errno names; tests mark those samples as synthetic.
 */

/** HTTP statuses of an API error that mean "provider unavailable" (other 4xx are our bugs). */
export function isUnavailableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** `api_error` values of a result event. Recorded: usage_limit_reached. */
export const UNAVAILABLE_API_ERRORS: readonly string[] = [
  "usage_limit_reached",
  "rate_limit_error",
  "overloaded_error",
];

/**
 * Text of an error result. Used only when the result is an error (`is_error`), as a second
 * signal next to the structured fields. Recorded: "You've hit your session limit · resets …".
 */
export const UNAVAILABLE_RESULT_TEXT: readonly RegExp[] = [/\bhit your session limit\b/i];

/**
 * stderr of a CLI run that exited non-zero without any result event: the API was not reached.
 * Node network errno names (synthetic samples in tests; no live sample recorded).
 */
export const UNAVAILABLE_STDERR: readonly RegExp[] = [
  /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b/,
];

export interface ResultErrorFields {
  is_error?: boolean | undefined;
  api_error_status?: number | null | undefined;
  api_error?: string | null | undefined;
  result?: string | undefined;
  errors?: string[] | undefined;
}

/** A `result` event the provider refused. */
export function resultIsProviderUnavailable(event: ResultErrorFields): boolean {
  if (!event.is_error) return false;
  const status = event.api_error_status;
  if (typeof status === "number" && isUnavailableStatus(status)) return true;
  if (event.api_error && UNAVAILABLE_API_ERRORS.includes(event.api_error)) return true;
  // A structured 4xx other than 429 is a request the factory built wrongly, whatever the text.
  if (typeof status === "number") return false;
  const text = [event.result ?? "", ...(event.errors ?? [])].join("\n");
  return UNAVAILABLE_RESULT_TEXT.some((re) => re.test(text));
}

/** A non-zero exit without a result event, caused by the provider being unreachable. */
export function exitIsProviderUnavailable(exitCode: number | null, stderr: string): boolean {
  return exitCode !== 0 && UNAVAILABLE_STDERR.some((re) => re.test(stderr));
}
