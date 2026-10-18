// Candidate role configuration (Week 3 Phase 2): Sonnet 5.5 plans and develops, Opus 5.5
// reviews. Used for one eval against the Week 3 baseline (Opus in every role):
//   FACTORY_CONFIG=factory.sonnet-dev.config.ts npm run eval
// Everything except the models is the same as factory.config.ts. Whether it becomes the
// default is the project owner's decision, by the numbers.
import base from "./factory.config.js";
import type { FactoryConfigInput } from "./src/config/load-config.js";

const config: FactoryConfigInput = {
  ...base,
  roles: {
    planner: { runtime: "claude-code", model: "claude-sonnet-5-5" },
    developer: { runtime: "claude-code", model: "claude-sonnet-5-5" },
    reviewer: { runtime: "claude-code", model: "claude-opus-5-5" },
  },
};

export default config;
