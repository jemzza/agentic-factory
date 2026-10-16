// Factory configuration, validated with Zod at load time (src/config/load-config.ts).
// Secrets never go here: provider keys live in .env (git-ignored) and are referenced by
// variable name only.
import type { FactoryConfigInput } from "./src/config/load-config.js";

const config: FactoryConfigInput = {
  workdir: "~/agentic-factory-work",
  target: {
    name: "taskflow",
    source: { kind: "fixture", path: "fixtures/taskflow" },
    install: ["npm", "ci", "--no-audit", "--no-fund"],
    checks: [
      { name: "typecheck", command: ["npm", "run", "typecheck"] },
      { name: "test", command: ["npm", "test"] },
    ],
    conventionsFile: "CLAUDE.md",
  },
  roles: {
    planner: { runtime: "claude-code", model: "opus" },
    developer: { runtime: "claude-code", model: "opus" },
    // Independent reviewer from another vendor (OpenCode, read-only). Exact model id from the
    // OpenCode catalog: GPT-6.1 Sol, released 2026-09-29 (no dated snapshot id exists).
    reviewer: { runtime: "opencode", model: "openai/gpt-6.1-sol", keyEnv: ["OPENAI_API_KEY"] },
  },
  // `npm run eval:review` compares these reviewers on evals/review/.
  reviewEval: {
    reviewers: [
      { runtime: "claude-code", model: "opus" },
      { runtime: "opencode", model: "openai/gpt-6.1-sol", keyEnv: ["OPENAI_API_KEY"] },
    ],
  },
  secretEnv: ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  stepTimeoutsMinutes: { planner: 5, developer: 15, reviewer: 5, check: 5 },
  maxDiffCharsForReview: 150000,
  evalCostCapUsd: 10,
};

export default config;
