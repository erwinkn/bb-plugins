import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: process.allowedNodeEnvironmentFlags.has("--no-experimental-webstorage")
          ? ["--no-experimental-webstorage"]
          : [],
      },
    },
  },
});
