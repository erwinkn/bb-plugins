import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
