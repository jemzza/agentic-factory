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

/**
 * The host was suspended (sleep, lid closed) while a step ran: a timeout or failure across it
 * is not an agent or factory result (detection: src/process/host-suspend.ts). Recorded
 * 2026-10-18: a developer step's 15-minute timeout fired after 96 minutes of sleep, and the
 * next planner call after wake saw only api_retry events (no network).
 */
export function hostSuspendedMessage(proc: { suspendedMs?: number | undefined }): string | null {
  if (proc.suspendedMs === undefined || proc.suspendedMs <= 0) return null;
  return `the host was suspended (sleep) for ${Math.round(proc.suspendedMs / 1000)} s during this step; not an agent result`;
}

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

/**
 * Error text of a runtime that reports provider errors as messages (Pi: an assistant message's
 * `errorMessage` / `auto_retry_end.finalError`). Seen live with Pi 1.0.2 against a fake
 * server: "429: {\"message\":\"Rate limit reached…\",\"type\":\"rate_limit_error\"}" and, with
 * the server down, "Connection error.". The 5xx, overload and usage-limit forms are synthetic.
 */
export const UNAVAILABLE_ERROR_TEXT: readonly RegExp[] = [
  /^(429|5\d\d)\b/,
  /\b(rate[_ ]limit|overloaded|usage[_ ]limit)/i,
  /^Connection error\b/i,
  ...UNAVAILABLE_RESULT_TEXT,
  ...UNAVAILABLE_STDERR,
];

export function errorTextIsProviderUnavailable(text: string): boolean {
  return UNAVAILABLE_ERROR_TEXT.some((re) => re.test(text.trim()));
}

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

/*
 * A step timeout during which the API never answered. Recorded evidence (Claude Code 2.1.300,
 * 2026-10-17, src/runtimes/__fixtures__/live-api-retry-timeout-2.1.300.json): the stream-json
 * log holds one {"type":"system","subtype":"init",...} line followed only by retry notices
 *   {"type":"system","subtype":"api_retry","attempt":N,"max_retries":10,"retry_delay_ms":...,
 *    "error_status":null,"error":"unknown","session_id":...,"uuid":...}
 * and no assistant/user/result events; the factory's step timeout then killed the process.
 * Any other event (assistant text, tool use, any other subtype) means the model did work, so
 * the step stays a plain `timeout`. Lines that are not JSON objects (a line cut off by the
 * kill) are skipped, like in parseStreamJson.
 */
const PRE_ANSWER_SUBTYPES: readonly string[] = ["init", "api_retry"];

/** stdout of a timed-out run: only init + at least one api_retry event, nothing else. */
export function timeoutIsProviderUnavailable(stdout: string): boolean {
  let retries = 0;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) return false;
    const { type, subtype } = event as { type?: unknown; subtype?: unknown };
    if (type !== "system" || typeof subtype !== "string") return false;
    if (!PRE_ANSWER_SUBTYPES.includes(subtype)) return false;
    if (subtype === "api_retry") retries++;
  }
  return retries > 0;
}
