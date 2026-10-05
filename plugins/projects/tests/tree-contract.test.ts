import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { treeSchema } from "../lib/tree-schema";
it("accepts the versioned public tree fixture", () => {
  expect(
    treeSchema.parse(
      JSON.parse(
        readFileSync(
          new URL("./fixtures/tree.v1.json", import.meta.url),
          "utf8",
        ),
      ),
    ).version,
  ).toBe(1);
});
