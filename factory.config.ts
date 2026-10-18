// Factory configuration, validated with Zod at load time (src/config/load-config.ts).
// Secrets never go here: provider keys live in .env (git-ignored) and are referenced by
// variable name only. Projects are not configured here: they are registered in
// projects.yaml, and each project's rules live in its own .factory/config.yaml.
// Another file can be used for one command with FACTORY_CONFIG=<file>.
import type { FactoryConfigInput } from "./src/config/load-config.js";

const config: FactoryConfigInput = {
  workdir: "~/agentic-factory-work",
  roles: {
    planner: { runtime: "claude-code", model: "opus" },
    developer: { runtime: "claude-code", model: "opus" },
    // Same vendor and model as the developer: the OpenCode reviewer (OpenAI) is disabled by the
    // project owner's decision. Review independence is therefore lower than the architecture
    // intends. The OpenCode runtime (src/runtimes/opencode.ts) stays available; to re-enable it:
    //   reviewer: { runtime: "opencode", model: "openai/gpt-6.1-sol", keyEnv: ["OPENAI_API_KEY"] },
    reviewer: { runtime: "claude-code", model: "opus" },
  },
  // `npm run eval:review` compares these reviewers on evals/review/.
  reviewEval: {
    reviewers: [{ runtime: "claude-code", model: "opus" }],
  },
  secretEnv: ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  stepTimeoutsMinutes: { planner: 5, developer: 15, reviewer: 5, check: 5 },
  maxDiffCharsForReview: 150000,
  evalCostCapUsd: 10,
};

export default config;
