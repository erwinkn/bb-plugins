import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugins-acp-bridge",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**"],
    testTimeout: 30_000,
  },
});
