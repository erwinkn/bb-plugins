import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createRef, type ReactElement } from "react";
import PierreSurface, { type PierreSurfaceHandle, type PierreSurfaceProps } from "./PierreSurface";

vi.mock("@/lib/client-log", () => ({ reportCrash: vi.fn() }));
vi.mock("@/lib/pierre-loader", () => ({ loadPierre: vi.fn() }));
vi.mock("@/lib/pierre-theme", () => {
  let revision = 0;
  return {
    applyPierreTheme: vi.fn(() => "theme"),
    CACHE_NAMESPACE: "test",
    describeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    nextCacheRevision: () => ++revision,
    PIERRE_HOST_CSS: "",
    pierreCssVariables: () => ({}),
    synchronizePierreTheme: vi.fn(async () => "theme"),
  };
});

interface FakeEditorOptions {
  onAttach?: (editor: FakeEditor) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

interface FakeOptions {
  onPostRender?: (node: unknown, instance: unknown, phase: string, context: { item: { id: string; edit: boolean } }) => void;
  createEditor?: (type: string, options: FakeEditorOptions) => FakeEditor;
}

class FakeEditor {
  constructor(
    readonly type: string,
    readonly options: FakeEditorOptions,
  ) {}
  focus = vi.fn();
  getViewState() {
    return { selections: [] as unknown[] };
  }
  getText() {
    return "";
  }
}

/** A Pierre stand-in whose synchronous entry points can be made to throw. */
function fakeRuntime(behavior: {
  setItems?: (items: { id: string; edit?: boolean }[], options: FakeOptions) => void;
  setOptions?: () => void;
  updateItem?: () => void;
  render?: () => void;
  cleanUp?: () => void;
} = {}) {
  const views: FakeCodeView[] = [];
  class FakeCodeView {
    constructor(options: FakeOptions) {
      this.options = options;
      views.push(this);
    }
    options: FakeOptions;
    host: HTMLElement | null = null;
    cleaned = false;
    items: { id: string; edit?: boolean }[] = [];
    private editors = new Map<string, FakeEditor>();
    setup(host: HTMLElement) {
      this.host = host;
    }
    setItems(items: { id: string; edit?: boolean }[]) {
      if (behavior.setItems !== undefined) {
        behavior.setItems(items, this.options);
        return;
      }
      this.items = items;
      for (const item of items) {
        if (item.edit === true && this.options.createEditor !== undefined) {
          const editor = this.options.createEditor("file", {});
          this.editors.set(item.id, editor);
          // Pierre attaches the editor after the item renders.
          editor.options.onAttach?.(editor);
        }
      }
      this.options.onPostRender?.({ shadowRoot: null }, null, "render", {
        item: { id: items[0]!.id, edit: items[0]!.edit === true },
      });
    }
    updateItem() {
      behavior.updateItem?.();
    }
    setOptions() {
      behavior.setOptions?.();
    }
    onThemeChange() {}
    render() {
      behavior.render?.();
    }
    cleanUp() {
      this.cleaned = true;
      behavior.cleanUp?.();
    }
    getEditor(id: string) {
      return this.editors.get(id);
    }
  }
  return {
    views,
    runtime: {
      CodeView: FakeCodeView,
      Editor: FakeEditor,
      parseDiffFromFile: () => ({ hunks: [] }),
      parsePatchFiles: () => [],
      registerCustomTheme: () => {},
      getOrCreateWorkerPoolSingleton: () => null,
      version: "test",
      loadFont: async () => {},
      workerPool: null,
    },
  };
}

const theme = { id: "t", type: "dark", data: null, fallback: "github-dark" } as PierreSurfaceProps["theme"];

function surface(overrides: Partial<PierreSurfaceProps> = {}): ReactElement {
  return (
    <PierreSurface
      baseUrl="/assets"
      viewId="view-1"
      name="a.ts"
      content="const a = 1;\n"
      epoch={0}
      theme={theme}
      {...overrides}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function statusOf(container: HTMLElement): Promise<string> {
  const root = container.firstElementChild as HTMLElement;
  await waitFor(() => expect(["ready", "error"]).toContain(root.dataset.pierreStatus));
  return root.dataset.pierreStatus!;
}

describe("PierreSurface crash isolation", () => {
  it("reaches ready when the runtime renders", async () => {
    const { runtime } = fakeRuntime();
    const { loadPierre } = await import("@/lib/pierre-loader");
    vi.mocked(loadPierre).mockResolvedValue(runtime as never);
    const { container } = render(surface());
    expect(await statusOf(container)).toBe("ready");
  });

  it("a throwing setItems publishes a surface error instead of escaping", async () => {
    const { runtime } = fakeRuntime({ setItems: () => { throw new Error("setItems exploded"); } });
    const { loadPierre } = await import("@/lib/pierre-loader");
    vi.mocked(loadPierre).mockResolvedValue(runtime as never);
    const onStatusChange = vi.fn();
    const { container } = render(surface({ onStatusChange }));
    expect(await statusOf(container)).toBe("error");
    expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", message: "setItems exploded" }));
  });

  it("a throwing setOptions publishes a surface error", async () => {
    const { runtime } = fakeRuntime({ setOptions: () => { throw new Error("setOptions exploded"); } });
    const { loadPierre } = await import("@/lib/pierre-loader");
    vi.mocked(loadPierre).mockResolvedValue(runtime as never);
    // Read-only items never attach an editor, so the recovery publish that
    // follows the theme sync cannot clear the error.
    const { container } = render(surface({ wrap: true, readOnly: true }));
    // The options effect runs once the surface exists; the theme sync resolves first.
    await waitFor(() => {
      const root = container.firstElementChild as HTMLElement;
      expect(root.dataset.pierreStatus === "error").toBe(true);
    });
  });

  it("a throwing updateItem on an external edit publishes a surface error", async () => {
    const { runtime } = fakeRuntime({ updateItem: () => { throw new Error("updateItem exploded"); } });
    const { loadPierre } = await import("@/lib/pierre-loader");
    vi.mocked(loadPierre).mockResolvedValue(runtime as never);
    const { container, rerender } = render(surface({ readOnly: true }));
    expect(await statusOf(container)).toBe("ready");
    // Another author's edit replaces the document through updateItem.
    rerender(surface({ readOnly: true, epoch: 1, epochAuthor: "other-view" }));
    expect(await statusOf(container)).toBe("error");
  });

  it("a throwing buildItem publishes a surface error", async () => {
    const { runtime } = fakeRuntime();
    (runtime as { parseDiffFromFile: () => { hunks: never[] } }).parseDiffFromFile = () => {
      throw new Error("parse exploded");
    };
    const { loadPierre } = await import("@/lib/pierre-loader");
    vi.mocked(loadPierre).mockResolvedValue(runtime as never);
    const { container } = render(surface({ oldContent: "old\n" }));
    expect(await statusOf(container)).toBe("error");
  });

  it("a throwing cleanUp on unmount reports but does not throw", async () => {
    const { runtime } = fakeRuntime({ cleanUp: () => { throw new Error("cleanup exploded"); } });
    const { loadPierre } = await import("@/lib/pierre-loader");
    vi.mocked(loadPierre).mockResolvedValue(runtime as never);
    const { reportCrash } = await import("@/lib/client-log");
    const { container, unmount } = render(surface());
    expect(await statusOf(container)).toBe("ready");
    expect(() => unmount()).not.toThrow();
    expect(reportCrash).toHaveBeenCalledWith(expect.objectContaining({ phase: "pierre:cleanup" }), expect.any(Error));
  });

  it("a failing bundle load publishes a surface error", async () => {
    const { loadPierre } = await import("@/lib/pierre-loader");
    vi.mocked(loadPierre).mockRejectedValue(new Error("no bundle"));
    const { container } = render(surface());
    expect(await statusOf(container)).toBe("error");
  });
});

describe("PierreSurface document switching", () => {
  it("sizes itself from the caller's insets, not a fixed height", async () => {
    // h-full on an element offset by top-*/bottom-* over-constrains the box:
    // bottom loses, the surface overflows its parent, and the file's last
    // lines are clipped below the visible area.
    const { runtime } = fakeRuntime();
    const { loadPierre } = await import("@/lib/pierre-loader");
    vi.mocked(loadPierre).mockResolvedValue(runtime as never);
    const { container } = render(surface({ className: "absolute inset-x-0 bottom-0 top-8" }));
    expect(await statusOf(container)).toBe("ready");
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toContain("h-full");
    expect(root.className).toContain("top-8");
  });

  it("rebuilds the view when the document identity changes", async () => {
    const { runtime, views } = fakeRuntime();
    const { loadPierre } = await import("@/lib/pierre-loader");
    vi.mocked(loadPierre).mockResolvedValue(runtime as never);
    const { container, rerender } = render(surface({ name: "a.ts" }));
    expect(await statusOf(container)).toBe("ready");
    expect(views).toHaveLength(1);
    rerender(surface({ name: "b.ts" }));
    await waitFor(() => expect(views).toHaveLength(2));
    // Reusing the view through setItems would carry its scroll offsets and
    // layout anchors into a document they were never measured for.
    expect(views[0]!.cleaned).toBe(true);
    expect(await statusOf(container)).toBe("ready");
  });

  it("starts a new document at the top of the scroll container", async () => {
    const { runtime, views } = fakeRuntime();
    const { loadPierre } = await import("@/lib/pierre-loader");
    vi.mocked(loadPierre).mockResolvedValue(runtime as never);
    const { container, rerender } = render(surface({ name: "a.ts" }));
    expect(await statusOf(container)).toBe("ready");
    const host = views[0]!.host!;
    host.scrollTop = 500;
    rerender(surface({ name: "b.ts" }));
    await waitFor(() => expect(views).toHaveLength(2));
    expect(await statusOf(container)).toBe("ready");
    expect(host.scrollTop).toBe(0);
  });

  it("focuses the caret without scrolling, unless given a line target", async () => {
    const { runtime, views } = fakeRuntime();
    const { loadPierre } = await import("@/lib/pierre-loader");
    vi.mocked(loadPierre).mockResolvedValue(runtime as never);
    const ref = createRef<PierreSurfaceHandle>();
    const { container } = render(surface({ ref }));
    expect(await statusOf(container)).toBe("ready");
    const editor = views[0]!.getEditor(views[0]!.items[0]!.id) as FakeEditor;
    expect(ref.current!.focus()).toBe(true);
    // A bare focus scrolls every scrollable ancestor to reveal the caret,
    // which can push the pane's first lines out of view.
    expect(editor.focus).toHaveBeenCalledWith({ lineNumber: "first-visible", preventScroll: true });
    expect(ref.current!.focus({ lineNumber: 3 })).toBe(true);
    expect(editor.focus).toHaveBeenCalledWith({ lineNumber: 3 });
  });
});
