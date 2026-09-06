import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use jsdom storage, not Node 26's unrelated native Web Storage global.
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--no-experimental-webstorage"] } },
  },
});
