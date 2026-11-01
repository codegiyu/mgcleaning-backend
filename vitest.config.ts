import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Integration suites need their own config (guarded, migrated database): never run them here.
    exclude: ["dist/**", "node_modules/**", "src/**/*.int.test.ts"],
    // Password tests hash at the real scrypt cost (about 64 MiB each); with every file
    // running in parallel a few derivations can pass the 5 s default.
    testTimeout: 20_000,
  },
});
