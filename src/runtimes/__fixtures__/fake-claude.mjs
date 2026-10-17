// Fake Claude Code CLI for adapter tests. Usage: node fake-claude.mjs <mode> [claude flags...]
// Reads the prompt from stdin and prints stream-json like the real CLI.
import { spawn } from "node:child_process";

const [mode, ...flags] = process.argv.slice(2);
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const stdin = await new Promise((resolve) => {
  let data = "";
  process.stdin.on("data", (c) => (data += c));
  process.stdin.on("end", () => resolve(data));
});

const result = (extra) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 5,
  },
  num_turns: 3,
  permission_denials: [],
  terminal_reason: "completed",
  // Live success results carry an explicit null here (Claude Code 2.1.300).
  api_error_status: null,
  ...extra,
});

out({ type: "system", subtype: "init", tools: [] });
switch (mode) {
  case "success":
    out({ type: "assistant", message: {} });
    out(result({}));
    out({ type: "system", subtype: "task_summary" }); // result is not the last line
    break;
  case "structured":
    out(result({ result: '{"plan":"x"}', structured_output: { plan: "x" } }));
    break;
  case "structured-missing":
    out(result({ result: "I made a plan but here it is in prose." }));
    break;
  case "echo":
    out(result({ result: JSON.stringify({ flags, stdin, env: Object.keys(process.env).sort() }) }));
    break;
  case "denied":
    out(
      result({
        permission_denials: [
          { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "curl x" } },
        ],
      }),
    );
    break;
  case "garbage":
    process.stdout.write("this is not json\n{broken\n");
    break;
  case "malformed-result":
    out({ type: "result", subtype: "success" }); // is_error missing
    break;
  case "network-down":
    // Synthetic (no live sample recorded): the API is unreachable, so no result event is written.
    process.stderr.write("Error: connect ECONNREFUSED 160.79.104.10:443\n");
    process.exit(1);
    break;
  case "crash":
    process.stderr.write("Error: something exploded\n");
    process.exit(3);
    break;
  case "budget":
    out(
      result({
        subtype: "error_max_budget_usd",
        is_error: true,
        result: undefined,
        terminal_reason: "budget_exhausted",
        errors: ["Reached maximum budget ($0.01)"],
        total_cost_usd: 0.05,
      }),
    );
    process.exit(1);
    break;
  case "usage-limit":
    // Shape observed live (Claude Code 2.1.300) when the subscription session limit is hit.
    out({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1792167000, rateLimitType: "five_hour" },
    });
    out(
      result({
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 429,
        api_error: "usage_limit_reached",
        result: "You've hit your session limit · resets 7:10pm (Europe/Moscow)",
        total_cost_usd: 0,
      }),
    );
    process.exit(1);
    break;
  case "bad-request":
    out(
      result({
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 400,
        api_error: "invalid_request_error",
        result: "output_format.schema: invalid",
      }),
    );
    process.exit(1);
    break;
  case "error-result":
    out(result({ subtype: "error_during_execution", is_error: true, errors: ["API overloaded"] }));
    process.exit(1);
    break;
  case "success-nonzero":
    out(result({}));
    process.exit(2);
    break;
  case "hang": {
    // Spawns a grandchild (like an agent running `npm test`) and hangs forever.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    out({ type: "system", subtype: "grandchild", pid: child.pid });
    setInterval(() => {}, 1000);
    break;
  }
  default:
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exit(64);
}
