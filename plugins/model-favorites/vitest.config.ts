import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    testTimeout: 60000,
    include: ["*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**"],
    setupFiles: ["./test-setup.ts"],
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
