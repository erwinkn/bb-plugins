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

    const preview = screen.getByTestId("markdown-preview");
    expect(preview.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "w-full", "overflow-y-auto", "overflow-x-hidden"]));
    expect(preview.className.split(" ")).not.toContain("overflow-auto");

    const markdown = screen.getByTestId("bb-markdown");
    expect(markdown.className.split(" ")).toEqual(expect.arrayContaining(["w-full", "min-w-0", "max-w-3xl"]));
  });
});
