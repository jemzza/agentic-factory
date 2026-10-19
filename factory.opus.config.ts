// Alternative role configuration: Opus 5.5 in every role (the Week 3 configuration before the
// owner switched planner and developer to Sonnet, docs/week3-results.md). For comparisons:
//   FACTORY_CONFIG=factory.opus.config.ts npm run eval
// Everything except the models is the same as factory.config.ts.
import base from "./factory.config.js";
import type { FactoryConfigInput } from "./src/config/load-config.js";

const config: FactoryConfigInput = {
  ...base,
  roles: {
    ...base.roles,
    planner: { runtime: "claude-code", model: "claude-opus-5-5" },
    developer: { runtime: "claude-code", model: "claude-opus-5-5" },
  },
};

export default config;
