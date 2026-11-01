import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
    // Password tests hash at the real scrypt cost (about 64 MiB each); with every file
    // running in parallel a few derivations can pass the 5 s default.
    testTimeout: 20_000,
  },
});
