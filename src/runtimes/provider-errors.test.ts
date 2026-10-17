import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseStreamJson } from "./claude-code.js";
import { exitIsProviderUnavailable, resultIsProviderUnavailable } from "./provider-errors.js";

const LIVE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "live-result-events-2.1.300.json",
);

describe("provider unavailable: recorded Claude Code 2.1.300 output", () => {
  it("classifies the recorded session-limit result as infra and the recorded success as not", async () => {
    const live = JSON.parse(await readFile(LIVE, "utf8")) as Record<string, unknown>;
    const limited = parseStreamJson(JSON.stringify(live["usage_limit"]));
    const ok = parseStreamJson(
      [JSON.stringify(live["rate_limit_event_allowed"]), JSON.stringify(live["success"])].join(
        "\n",
      ),
    );
    if (limited.kind !== "result" || ok.kind !== "result") throw new Error("expected results");
    expect(resultIsProviderUnavailable(limited.event)).toBe(true);
    // A successful run with an informational rate_limit_event ("allowed") is not an error.
    expect(resultIsProviderUnavailable(ok.event)).toBe(false);
  });

  it("recognizes the recorded session-limit text even without the structured fields", () => {
    // Same text as the recorded result; structured fields removed (older CLI shape).
    expect(
      resultIsProviderUnavailable({
        is_error: true,
        result: "You've hit your session limit · resets 7:10pm (Europe/Moscow)",
      }),
    ).toBe(true);
    // The text alone on a non-error result is not a failure.
    expect(resultIsProviderUnavailable({ is_error: false, result: "hit your session limit" })).toBe(
      false,
    );
  });
});

describe("provider unavailable: synthetic samples (no live recording yet)", () => {
  it.each([
    ["API rate limit", { is_error: true, api_error_status: 429, api_error: "rate_limit_error" }],
    ["overloaded", { is_error: true, api_error_status: 529, api_error: "overloaded_error" }],
    ["5xx", { is_error: true, api_error_status: 503 }],
  ])("%s → infra", (_name, event) => {
    expect(resultIsProviderUnavailable(event)).toBe(true);
  });

  it("keeps requests the factory built wrongly as non-infra, whatever the text", () => {
    expect(
      resultIsProviderUnavailable({
        is_error: true,
        api_error_status: 400,
        api_error: "invalid_request_error",
        result: "hit your session limit",
      }),
    ).toBe(false);
    expect(resultIsProviderUnavailable({ is_error: true, errors: ["API overloaded"] })).toBe(false);
  });

  it("treats a non-zero exit with a network errno and no result as infra", () => {
    expect(exitIsProviderUnavailable(1, "Error: connect ECONNREFUSED 160.79.104.10:443")).toBe(
      true,
    );
    expect(exitIsProviderUnavailable(1, "getaddrinfo ENOTFOUND api.anthropic.com")).toBe(true);
    expect(exitIsProviderUnavailable(0, "ECONNRESET")).toBe(false);
    expect(exitIsProviderUnavailable(3, "Error: something exploded")).toBe(false);
  });
});
