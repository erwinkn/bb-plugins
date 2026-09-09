import assert from "node:assert/strict";
import test from "node:test";
import { EDITOR_COMMANDS, type ActiveEditor } from "./editor-commands";
import type { PierreSurfaceHandle } from "../components/PierreSurface";

test("preview commands wait for the surface and undo stays unavailable", () => {
  const calls: string[] = [];
  let pending: ((handle: PierreSurfaceHandle) => void) | null = null;
  const active: ActiveEditor = {
    id: "preview", element: null, handle: null, absolutePath: "a.md", relativePath: "a.md",
    save() {}, quickOpen: null, toggleTree: null, toggleWordWrap: null,
    withEditor(run) { pending = run; },
    goToLine() { active.withEditor?.(() => calls.push("line")); },
  };
  const handle = {
    focus: () => calls.push("focus"), openSearch: () => calls.push("find"),
    openSearchReplace: () => calls.push("replace"),
  } as unknown as PierreSurfaceHandle;
  for (const [id, expected] of [["find", "find"], ["find-replace", "replace"], ["go-to-line", "line"]]) {
    const command = EDITOR_COMMANDS.find((item) => item.id === id)!;
    assert.equal(command.precondition?.(active), true);
    const before = calls.length;
    command.run(active);
    assert.equal(calls.length, before, "the preview has no editor yet");
    assert.notEqual(pending, null);
    (pending as unknown as (handle: PierreSurfaceHandle) => void)(handle);
    assert.equal(calls.at(-1), expected);
  }
  assert.equal(EDITOR_COMMANDS.find((item) => item.id === "undo")!.precondition?.(active), false);
  active.withEditor = null;
  assert.equal(EDITOR_COMMANDS.find((item) => item.id === "find")!.precondition?.(active), false);
});
