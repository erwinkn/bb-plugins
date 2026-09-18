import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FileSessionSource } from "@/lib/file-session";
import { MarkdownPreview } from "./MarkdownPreview";

let markdownThrows = true;
vi.mock("@get-bb/plugin-sdk/app", () => ({
  Markdown: ({ content, className }: { content: string; className?: string }) => {
    if (markdownThrows) throw new Error("markdown exploded");
    return <div data-testid="bb-markdown" className={className}>{content}</div>;
  },
  useRpc: () => ({ call: vi.fn(async () => ({ baseUrl: "/preview", expiresAtMs: Date.now() + 300_000 })) }),
}));
vi.mock("@/lib/editor-commands", () => ({ copyText: vi.fn(async () => {}) }));
vi.mock("@/lib/client-log", () => ({ reportCrash: vi.fn() }));

const source: FileSessionSource = { kind: "workspace", threadId: "thr_1", environmentId: "env_1", projectId: "p_1" };

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
/** Shaped like the document that produced the scrollbar ResizeObserver loop. */
const nativePartsLab = readFileSync(path.join(fixtureDir, "fixtures", "native-parts-lab.md"), "utf8");

/** The guards that keep a document's layout from feeding the observed widths. */
function expectStableWidths() {
  const preview = screen.getByTestId("markdown-preview");
  expect(preview.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "w-full", "overflow-y-auto", "overflow-x-hidden"]));
  expect(preview.className.split(" ")).not.toContain("overflow-auto");
  // The scroller's clientWidth must not change when the scrollbar appears.
  expect(preview.style.scrollbarGutter).toBe("stable");

  const markdown = screen.getByTestId("bb-markdown");
  expect(markdown.className.split(" ")).toEqual(expect.arrayContaining(["w-full", "min-w-0"]));
  const wrapper = markdown.parentElement;
  expect(wrapper).not.toBeNull();
  // The measured box is pinned to the pane and sealed from its contents.
  expect(wrapper!.className.split(" ")).toEqual(expect.arrayContaining(["w-full", "min-w-0", "max-w-3xl"]));
  expect(wrapper!.style.contain).toBe("inline-size");
}

afterEach(() => {
  cleanup();
  markdownThrows = true;
  vi.restoreAllMocks();
});

describe("MarkdownPreview crash isolation", () => {
  it("a throwing Markdown renderer falls back inside the tab", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <MarkdownPreview source={source} path="notes.md" relativePath="notes.md" rootPath="" content="# hi" onOpenPath={null} />,
    );
    expect(screen.getByTestId("editor-tab-fallback")).toBeTruthy();
    expect(screen.getByText("notes.md")).toBeTruthy();
    fireEvent.click(screen.getByText("Open as plain text"));
    expect(screen.getByTestId("plain-text-view").textContent).toContain("# hi");
  });

  it("renders the document when the renderer works", () => {
    markdownThrows = false;
    render(
      <MarkdownPreview source={source} path="notes.md" relativePath="notes.md" rootPath="" content="# hi" onOpenPath={null} />,
    );
    expect(screen.getByTestId("bb-markdown").textContent).toContain("# hi");
  });

  it("pins the Markdown root to the pane and confines wide-table overflow", () => {
    markdownThrows = false;
    render(
      <MarkdownPreview source={source} path="wide.md" relativePath="wide.md" rootPath="" content="| wide | table |" onOpenPath={null} />,
    );
    expectStableWidths();
  });

  // The document's images grew it across the scrollbar threshold; every load
  // flipped the scroller's clientWidth and the breakout rewrote its variables.
  it("keeps the observed widths stable for an image-and-table document", () => {
    markdownThrows = false;
    render(
      <MarkdownPreview source={source} path="native-parts-lab.md" relativePath="native-parts-lab.md" rootPath="" content={nativePartsLab} onOpenPath={null} />,
    );
    expectStableWidths();
  });
});
