import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorTabBoundary } from "./EditorTabBoundary";

vi.mock("@/lib/editor-commands", () => ({ copyText: vi.fn(async () => {}) }));
vi.mock("@/lib/client-log", () => ({ reportCrash: vi.fn() }));

let shouldThrow = true;
function Bomb() {
  if (shouldThrow) throw new Error("render exploded");
  return <div>editor body</div>;
}

afterEach(() => {
  cleanup();
  shouldThrow = true;
  vi.restoreAllMocks();
});

function renderBoundary() {
  return render(
    <EditorTabBoundary fileKey="k1" path="src/a.ts" content="file body" phase="editor">
      <Bomb />
    </EditorTabBoundary>,
  );
}

describe("EditorTabBoundary", () => {
  it("keeps notice rows and the flexing surface in normal-flow order", () => {
    shouldThrow = false;
    const { container } = render(
      <div className="flex h-96 flex-col">
        <EditorTabBoundary fileKey="k1" path="src/a.ts" content="file body" phase="editor">
          <div role="status">First notice</div>
          <div role="status">Second notice</div>
          <div data-testid="surface" className="min-h-0 w-full flex-1" />
        </EditorTabBoundary>
      </div>,
    );
    const surface = screen.getByTestId("surface");
    const boundary = surface.parentElement!;
    expect(boundary.className).toContain("flex");
    expect(boundary.className).toContain("min-h-0");
    expect(boundary.className).toContain("flex-1");
    expect(Array.from(boundary.children).map((element) => element.textContent || element.getAttribute("data-testid")))
      .toEqual(["First notice", "Second notice", "surface"]);
    expect(surface.className).toContain("flex-1");
    expect(container.innerHTML).not.toMatch(/\btop-(?:8|16)\b/);
  });

  it("shows the path and a safe message instead of a blank pane", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderBoundary();
    expect(screen.getByTestId("editor-tab-fallback")).toBeTruthy();
    expect(screen.getByText("The editor could not show this file.")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("render exploded")).toBeTruthy();
    screen.getByText("Retry");
    screen.getByText("Open as plain text");
    screen.getByText("Copy path");
  });

  it("reports the crash to the plugin log", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { reportCrash } = await import("@/lib/client-log");
    renderBoundary();
    expect(reportCrash).toHaveBeenCalledWith(expect.objectContaining({ phase: "editor", path: "src/a.ts" }), expect.any(Error));
  });

  it("open as plain text shows the buffer read-only", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderBoundary();
    fireEvent.click(screen.getByText("Open as plain text"));
    expect(screen.getByTestId("plain-text-view").textContent).toContain("file body");
    expect(screen.getByText(/read-only plain text/)).toBeTruthy();
  });

  it("retry remounts the child and recovers", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderBoundary();
    shouldThrow = false;
    fireEvent.click(screen.getByText("Retry"));
    expect(screen.getByText("editor body")).toBeTruthy();
  });

  it("a different file key resets the error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    shouldThrow = false;
    const view = renderBoundary();
    // The boundary errors only when the child throws; force one, then swap key.
    cleanup();
    shouldThrow = true;
    const keyed = render(
      <EditorTabBoundary fileKey="k1" path="src/a.ts" content="file body" phase="editor">
        <Bomb />
      </EditorTabBoundary>,
    );
    expect(keyed.getByTestId("editor-tab-fallback")).toBeTruthy();
    shouldThrow = false;
    keyed.rerender(
      <EditorTabBoundary fileKey="k2" path="src/b.ts" content="file body" phase="editor">
        <Bomb />
      </EditorTabBoundary>,
    );
    expect(keyed.getByText("editor body")).toBeTruthy();
    void view;
  });
});
