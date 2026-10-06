import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
    // Only supported production tests; unrelated .probes remain untouched.
    // Use jsdom storage, not Node 26's unrelated native Web Storage global.
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: process.allowedNodeEnvironmentFlags.has(
          "--no-experimental-webstorage",
        )
          ? ["--no-experimental-webstorage"]
          : [],
      },
    },
  },
});
