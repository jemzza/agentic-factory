// Live smoke test of the Pi reviewer on the local Ollama model ($0, nothing leaves the machine).
// Usage: npm run smoke:pi   — uses the pi binding of reviewEval.reviewers in factory.config.ts.
// Reviews a small diff with an obvious defect against an eval task, through the same prompt and
// single retry as the review node, and prints the verdict, attempts, time and tokens.
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSystemPrompt, promptVars } from "../src/agents/prompts.js";
import { REVIEWER_OUTPUT_SCHEMA, reviewerPrompt, reviewWithRetry } from "../src/agents/reviewer.js";
import { loadConfig } from "../src/config/load-config.js";
import { loadEvalStand } from "../src/eval/stand.js";
import { prepareTargetCopy } from "../src/eval/target-copy.js";
import { loadTaskSpec } from "../src/eval/tasks.js";
import { FACTORY_ROOT } from "../src/paths.js";
import { ClaudeCodeRuntime } from "../src/runtimes/claude-code.js";
import { runtimeForBinding } from "../src/runtimes/registry.js";
import { READ_ONLY_TOOLS } from "../src/runtimes/tool-policy.js";
import type { AgentRunResult } from "../src/runtimes/types.js";

const config = await loadConfig();
const binding = config.reviewEval.reviewers.find((b) => b.runtime === "pi");
if (!binding) throw new Error("no pi reviewer in reviewEval.reviewers");
const stand = await loadEvalStand();
const wt = path.join(await mkdtemp(path.join(os.tmpdir(), "factory-smoke-pi-")), "wt");
await prepareTargetCopy({ source: stand.fixtureDir, dest: wt });
const logDir = path.join(FACTORY_ROOT, "runs", `smoke-pi-${String(Date.now())}`);
const runtime = runtimeForBinding(
  binding,
  logDir,
  new ClaudeCodeRuntime({ logDir, models: config.models }),
  config.workdirAbs,
);

const task = await loadTaskSpec("complete-task");
// The same system prompt as the review node and eval:review (role instructions + conventions).
const systemPrompt = await buildSystemPrompt(
  "reviewer",
  await readFile(path.join(wt, stand.projectConfig.conventions_file), "utf8"),
  promptVars(stand.projectConfig),
);
// The defect: completing a deleted task succeeds instead of 409 CONFLICT, and no tests.
const diff = `diff --git a/src/services/task-service.ts b/src/services/task-service.ts
--- a/src/services/task-service.ts
+++ b/src/services/task-service.ts
@@ -60,3 +60,10 @@ export class TaskService {
+  async complete(id: string): Promise<Task> {
+    const task = await this.repository.findById(id);
+    if (!task) throw notFound(\`Task \${id} not found\`);
+    task.status = "done";
+    task.updatedAt = this.clock();
+    return this.repository.save(task);
+  }
`;
const results: AgentRunResult[] = [];
const started = Date.now();
const { outcome, attempts } = await reviewWithRetry(
  async (prompt) => {
    const r = await runtime.run({
      role: "reviewer",
      prompt,
      cwd: wt,
      allowedTools: [...READ_ONLY_TOOLS],
      timeoutMs: config.stepTimeoutsMinutes.reviewer * 60_000,
      model: binding.model,
      systemPrompt,
      outputSchema: REVIEWER_OUTPUT_SCHEMA,
    });
    results.push(r);
    return r;
  },
  reviewerPrompt(task, diff, config.maxDiffCharsForReview),
  task,
  (m) => {
    console.log(m);
  },
);
console.log(
  JSON.stringify(
    {
      reviewer: `${binding.runtime}:${binding.model}`,
      attempts,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      outcome,
      runs: results.map((r) => ({
        ok: r.ok,
        error: r.error,
        tokens: r.tokens,
        costUsd: r.costUsd,
        numTurns: r.numTurns,
        modelsUsed: r.modelsUsed,
        durationMs: r.durationMs,
        log: path.relative(FACTORY_ROOT, r.rawLogPath),
      })),
    },
    null,
    2,
  ),
);
