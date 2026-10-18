// Fake `pi --mode json -p` for adapter tests. Usage: node fake-pi.mjs <mode> [pi args...]
// "replay-*" modes print an event stream recorded from Pi 1.0.2 (against a fake provider).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [mode, ...args] = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const usage = (cost) => ({
  input: 1000,
  output: 200,
  cacheRead: 300,
  cacheWrite: 0,
  totalTokens: 1500,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const assistant = (text, stopReason = "stop", extra = {}) =>
  out({
    type: "message_end",
    message: {
      role: "assistant",
      content: text === null ? [] : [{ type: "text", text }],
      provider: "google",
      model: "gemini-x",
      usage: usage(0.01),
      stopReason,
      ...extra,
    },
  });
const stdin = () => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

switch (mode) {
  case "replay-ok":
    process.stdout.write(readFileSync(path.join(here, "live-guarded-review-1.0.2.jsonl")));
    break;
  case "replay-429":
    process.stdout.write(readFileSync(path.join(here, "live-429-retries-1.0.2.jsonl")));
    break; // exit 0, as Pi does
  case "echo": {
    // Reports what the adapter passed: argv, env names, stdin, cwd.
    out({ type: "session", version: 3, id: "s", cwd: process.cwd() });
    const report = {
      args,
      env: process.env,
      stdin: stdin(),
      cwd: process.cwd(),
    };
    assistant(`report ${JSON.stringify(report)}`);
    break;
  }
  case "nojson":
    out({ type: "session", version: 3, id: "s" });
    assistant("Looks fine to me.");
    break;
  case "budget":
    out({ type: "session", version: 3, id: "s" });
    out({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "{}" }],
        usage: usage(5),
        stopReason: "stop",
      },
    });
    break;
  case "length":
    out({ type: "session", version: 3, id: "s" });
    assistant('{"verdict":', "length");
    break;
  case "bad-request":
    out({ type: "session", version: 3, id: "s" });
    assistant(null, "error", { errorMessage: '400: {"message":"Unknown model"}' });
    break;
  case "retry-then-ok":
    out({ type: "session", version: 3, id: "s" });
    assistant(null, "error", { errorMessage: "529 overloaded" });
    out({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1,
      errorMessage: "529 overloaded",
    });
    assistant('{"verdict":"approve","issues":[],"criteria_check":[]}');
    out({ type: "auto_retry_end", success: true, attempt: 1 });
    break;
  case "retry-hang":
    out({ type: "session", version: 3, id: "s" });
    assistant(null, "error", { errorMessage: "Connection error." });
    out({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 60000,
      errorMessage: "Connection error.",
    });
    setTimeout(() => undefined, 60_000);
    break;
  case "hang":
    out({ type: "session", version: 3, id: "s" });
    assistant("thinking...", "toolUse");
    setTimeout(() => undefined, 60_000);
    break;
  case "crash":
    process.stderr.write("Error: model fake/x not found\n");
    process.exit(2);
    break;
  case "garbage":
    process.stdout.write("not json at all\n");
    break;
  default:
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exit(64);
}
