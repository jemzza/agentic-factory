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
    // Pi (read-only roles; docs/pi-runtime.md) — role and model are the owner's decision:
    //   reviewer: { runtime: "pi", model: "<provider>/<exact-model-id>", keyEnv: ["<PROVIDER>_API_KEY"] },
    //   (keyEnv: [] when the owner signed in to a subscription in the factory's Pi agent dir)
    reviewer: { runtime: "claude-code", model: "opus" },
  },
  // `npm run eval:review` compares these reviewers on evals/review/.
  reviewEval: {
    reviewers: [{ runtime: "claude-code", model: "opus" }],
  },
  // Masked in the DB, logs and reports; none of them is ever given to an agent or the sandbox.
  secretEnv: [
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "FACTORY_GITHUB_TOKEN",
  ],
  // Project memory (Mem0, infer:false; the rule text comes from the planner). Off until the
  // A/B measurement (docs/week3-results.md). Local embedder: Ollama on 127.0.0.1, pinned by
  // tag and digest. The OpenAI variant is supported by config only:
  //   embedder: { provider: "openai", model: "text-embedding-3-small", dims: 1536, keyEnv: "OPENAI_API_KEY" }
  // Changing the embedder requires `npm run memory -- reindex`.
  memory: {
    enabled: false,
    limit: 5,
    embedder: {
      provider: "ollama",
      url: "http://127.0.0.1:11434",
      model: "nomic-embed-text:latest",
      digest: "0a109f422b47",
      dims: 768,
    },
    indexDir: "data/memory",
  },
  // GitHub interface (npm run factory:watch); the token is FACTORY_GITHUB_TOKEN in .env.
  github: { tokenEnv: "FACTORY_GITHUB_TOKEN", pollIntervalSeconds: 60 },
  stepTimeoutsMinutes: { planner: 5, developer: 15, reviewer: 5, check: 5 },
  maxDiffCharsForReview: 150000,
  evalCostCapUsd: 10,
};

export default config;
