// Fake `opencode run --format json` for adapter tests. Usage: node fake-opencode.mjs <mode> run ...
import { spawn } from "node:child_process";
const [mode, ...args] = process.argv.slice(2);
const out = (e) =>
  process.stdout.write(JSON.stringify({ timestamp: 1, sessionID: "s1", ...e }) + "\n");
const message = args.at(-1) ?? "";
const verdict = {
  verdict: "approve",
  issues: [],
  criteria_check: [{ criterion: "c", met: true, evidence: "e" }],
};
switch (mode) {
  case "structured":
    out({ type: "step_start", part: {} });
    out({
      type: "text",
      part: { text: "Reviewed the diff.\n```json\n" + JSON.stringify(verdict) + "\n```" },
    });
    out({
      type: "step_finish",
      part: { cost: 0.0123, tokens: { input: 100, output: 20, cache: { read: 5, write: 1 } } },
    });
    break;
  case "no-cost":
    out({ type: "text", part: { text: JSON.stringify(verdict) } });
    out({ type: "step_finish", part: {} });
    break;
  case "prose":
    out({ type: "text", part: { text: "I think it is fine." } });
    break;
  case "error":
    out({ type: "error", error: { name: "APIError", data: { message: "invalid model" } } });
    process.exit(1);
    break;
  case "env":
    out({
      type: "text",
      part: {
        text: JSON.stringify({
          env: Object.keys(process.env).sort(),
          permission: process.env.OPENCODE_PERMISSION,
          args,
          message,
        }),
      },
    });
    break;
  case "leak":
    out({ type: "text", part: { text: `my key is ${process.env.OPENAI_API_KEY}` } });
    process.stderr.write(`debug key=${process.env.OPENAI_API_KEY}\n`);
    break;
  case "hang": {
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    setInterval(() => {}, 1000);
    break;
  }
  default:
    process.exit(64);
}
