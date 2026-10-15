import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Docker-dependent tests run separately via `npm run test:sandbox`.
    exclude: [
      "node_modules/**",
      "dist/**",
      "fixtures/**",
      "evals/**",
      "runs/**",
      "tests/integration/**",
    ],
    environment: "node",
    testTimeout: 20_000,
  },
});
