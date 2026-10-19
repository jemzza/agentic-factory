// Factory configuration, validated with Zod at load time (src/config/load-config.ts).
// Secrets never go here: provider keys live in .env (git-ignored) and are referenced by
// variable name only. Projects are not configured here: they are registered in
// projects.yaml, and each project's rules live in its own .factory/config.yaml.
// Another file can be used for one command with FACTORY_CONFIG=<file>.
import type { FactoryConfigInput } from "./src/config/load-config.js";

import type { RoleBindingInput } from "./src/schemas/config.js";

// Reviewers. The default stays Opus; switching to the Pi reviewer on a local Ollama model is the
// one-line change marked below (demo step). The owner decides by the eval:review / eval numbers.
const OPUS_REVIEWER: RoleBindingInput = { runtime: "claude-code", model: "opus" };
// Pi + Ollama on 127.0.0.1 (docs/pi-runtime.md). The owner pulls the base tag and creates the
// derived model from ollama/factory-reviewer-qwen2.5-coder-7b.Modelfile; the factory checks the
// pinned digest, the derived model and its num_ctx before every review. Never Claude in Pi.
const PI_OLLAMA_REVIEWER: RoleBindingInput = {
  runtime: "pi",
  model: "ollama/factory-reviewer-qwen2.5-coder-7b",
  ollama: {
    baseModel: "qwen2.5-coder:7b-instruct-q4_K_M",
    digest: "dae161e27b0e",
    numCtx: 32768,
    modelfile: "ollama/factory-reviewer-qwen2.5-coder-7b.Modelfile",
  },
};

const config: FactoryConfigInput = {
  workdir: "~/agentic-factory-work",
  roles: {
    // Owner's decision after the final block's items 1-2 (docs/week3-results.md): Sonnet plans and
    // develops (half the cost and time of Opus), Opus reviews (the filter before "success").
    planner: { runtime: "claude-code", model: "claude-sonnet-5-5" },
    developer: { runtime: "claude-code", model: "claude-sonnet-5-5" },
    // Same vendor and model as the developer: the OpenCode reviewer (OpenAI) is disabled by the
    // project owner's decision. Review independence is therefore lower than the architecture
    // intends. The OpenCode runtime (src/runtimes/opencode.ts) stays available; to re-enable it:
    //   reviewer: { runtime: "opencode", model: "openai/gpt-6.1-sol", keyEnv: ["OPENAI_API_KEY"] },
    // Demo / owner's switch — replace OPUS_REVIEWER with PI_OLLAMA_REVIEWER:
    reviewer: OPUS_REVIEWER,
  },
  // `npm run eval:review` compares these reviewers on evals/review/
  // (`-- --only pi` runs only the Pi reviewer).
  reviewEval: {
    reviewers: [OPUS_REVIEWER, PI_OLLAMA_REVIEWER],
  },
  // Masked in the DB, logs and reports; none of them is ever given to an agent or the sandbox.
  secretEnv: [
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "FACTORY_GITHUB_TOKEN",
  ],
  // Project memory (Mem0, infer:false; the rule text comes from the planner). On by the owner's
  // decision after the A/B (memory_on 8/8 vs memory_off 0/16, docs/week3-results.md). Needs
  // Ollama on 127.0.0.1 with the pinned embedder; without it runs go on and say so. Evals use
  // a fresh memory namespace per repeat, never the project's real memory. The OpenAI variant is supported by config only:
  //   embedder: { provider: "openai", model: "text-embedding-3-small", dims: 1536, keyEnv: "OPENAI_API_KEY" }
  // Changing the embedder requires `npm run memory -- reindex`.
  memory: {
    enabled: true,
    limit: 5,
    embedder: {
      provider: "ollama",
      url: "http://127.0.0.1:11434",
      model: "nomic-embed-text:0a109f422b47", // ollama cp nomic-embed-text:latest <this>
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
