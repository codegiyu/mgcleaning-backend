import { defineConfig } from "vitest/config";

/**
 * Integration tests run the real app against Postgres and Redis (see
 * `src/test/integration-setup.ts`). They wipe every table first, so the database name
 * must contain "test". Run with `npm run test:integration`.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.int.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    globalSetup: ["src/test/integration-setup.ts"],
    // One shared database: files must not interleave.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
