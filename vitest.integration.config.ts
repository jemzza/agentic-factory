import { defineConfig } from "vitest/config";

// Tests that need a running Docker daemon. Not part of `npm run check`; run with
// `npm run test:sandbox`.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 15 * 60_000,
    fileParallelism: false,
  },
});
