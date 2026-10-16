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
    // Independent reviewer: switch to OpenCode with another vendor's exact model id once the
    // key is in .env, e.g.
    //   reviewer: { runtime: "opencode", model: "openai/<exact-model-id>", keyEnv: ["OPENAI_API_KEY"] },
    reviewer: { runtime: "claude-code", model: "opus" },
  },
  // `npm run eval:review` compares these reviewers on evals/review/. Add the OpenCode
  // reviewer here (same shape as roles.reviewer) once its key is available.
  reviewEval: {
    reviewers: [{ runtime: "claude-code", model: "opus" }],
  },
  secretEnv: ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  stepTimeoutsMinutes: { planner: 5, developer: 15, reviewer: 5, check: 5 },
  maxDiffCharsForReview: 150000,
  evalCostCapUsd: 10,
};

export default config;
