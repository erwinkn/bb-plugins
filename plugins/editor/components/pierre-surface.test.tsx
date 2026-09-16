import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import PierreSurface, { type PierreSurfaceProps } from "./PierreSurface";

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

interface FakeOptions {
  onPostRender?: (node: unknown, instance: unknown, phase: string, context: { item: { id: string; edit: boolean } }) => void;
}

/** A Pierre stand-in whose synchronous entry points can be made to throw. */
function fakeRuntime(behavior: {
  setItems?: (items: { id: string }[], options: FakeOptions) => void;
  setOptions?: () => void;
  updateItem?: () => void;
  render?: () => void;
  cleanUp?: () => void;
} = {}) {
  const views: { options: FakeOptions }[] = [];
  class FakeCodeView {
    constructor(options: FakeOptions) {
      this.options = options;
      views.push(this);
    }
    options: FakeOptions;
    setup() {}
    setItems(items: { id: string }[]) {
      if (behavior.setItems !== undefined) {
        behavior.setItems(items, this.options);
        return;
      }
      this.options.onPostRender?.({ shadowRoot: null }, null, "render", {
        item: { id: items[0]!.id, edit: false },
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
      behavior.cleanUp?.();
    }
    getEditor() {
      return undefined;
    }
  }
  return {
    views,
    runtime: {
      CodeView: FakeCodeView,
      Editor: class {},
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
    const { container } = render(surface({ wrap: true }));
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
    const { container, rerender } = render(surface());
    expect(await statusOf(container)).toBe("ready");
    // Another author's edit replaces the document through updateItem.
    rerender(surface({ epoch: 1, epochAuthor: "other-view" }));
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
