import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const paneSources = [
  path.resolve(process.cwd(), "components/EditorPane.tsx"),
  path.resolve(process.cwd(), "components/EditableDiffPane.tsx"),
  path.resolve(process.cwd(), "components/MarkdownPreview.tsx"),
  path.resolve(process.cwd(), "components/PierreSurface.tsx"),
];

describe("editor pane layout", () => {
  it("uses normal-flow flex sizing instead of fixed top insets", () => {
    for (const path of paneSources) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/\btop-(?:8|16)\b/);
      expect(source).not.toContain("absolute inset-x-0 bottom-0");
    }

    const editor = readFileSync(paneSources[0]!, "utf8");
    const diff = readFileSync(paneSources[1]!, "utf8");
    const markdown = readFileSync(paneSources[2]!, "utf8");
    expect(editor).toContain('className="min-h-0 w-full flex-1"');
    expect(diff).toContain('className="min-h-0 w-full flex-1"');
    expect(markdown).toContain('className="flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-y-auto overflow-x-hidden bg-background"');
    expect(markdown).toContain('className="mx-auto w-full min-w-0 max-w-3xl px-6 py-5"');
  });
});
