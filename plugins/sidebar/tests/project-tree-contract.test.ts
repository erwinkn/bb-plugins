import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { treeSchema } from "../lib/project-tree-schema";
it("accepts Projects' versioned public fixture without a runtime dependency", () => {
  expect(
    treeSchema.parse(
      JSON.parse(
        readFileSync(
          new URL(
            "../../projects/tests/fixtures/tree.v1.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    ).version,
  ).toBe(1);
});
