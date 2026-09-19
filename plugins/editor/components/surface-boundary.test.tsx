import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SurfaceBoundary } from "./SurfaceBoundary";
import { reportCrash } from "@/lib/client-log";

vi.mock("@/lib/client-log", () => ({ reportCrash: vi.fn() }));
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => ({ call: vi.fn(async () => null) }) }));

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

describe("SurfaceBoundary", () => {
  it("renders children while nothing throws", () => {
    shouldThrow = false;
    render(
      <SurfaceBoundary phase="files-panel">
        <Bomb />
      </SurfaceBoundary>,
    );
    expect(screen.getByText("editor body")).toBeTruthy();
  });

  it("shows a retryable fallback and reports the crash", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <SurfaceBoundary phase="file-opener" path="src/a.py">
        <Bomb />
      </SurfaceBoundary>,
    );
    expect(screen.getByTestId("surface-fallback")).toBeTruthy();
    expect(screen.getByText("The editor surface crashed.")).toBeTruthy();
    expect(screen.getByText("src/a.py")).toBeTruthy();
    expect(screen.getByText("render exploded")).toBeTruthy();
    expect(reportCrash).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "file-opener", path: "src/a.py" }),
      expect.any(Error),
    );
    shouldThrow = false;
    fireEvent.click(screen.getByText("Retry"));
    expect(screen.getByText("editor body")).toBeTruthy();
  });

  it("clears the error when a different file opens", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <SurfaceBoundary phase="file-opener" path="src/a.py">
        <Bomb />
      </SurfaceBoundary>,
    );
    expect(screen.getByTestId("surface-fallback")).toBeTruthy();
    shouldThrow = false;
    rerender(
      <SurfaceBoundary phase="file-opener" path="src/b.py">
        <Bomb />
      </SurfaceBoundary>,
    );
    expect(screen.getByText("editor body")).toBeTruthy();
  });
});
