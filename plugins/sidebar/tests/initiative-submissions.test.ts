// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { CreatedInitiative } from "../lib/project-mode-contract";

// Two tabs share localStorage but each loads its own copy of the store.
type Store = typeof import("../lib/initiative-submissions");
async function openTab(): Promise<Store> {
  vi.resetModules();
  return import("../lib/initiative-submissions");
}
// What the browser tells the other tabs after a tab writes storage.
const announce = () =>
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
/**
 * Runs `other` in the gap between a tab reading storage and its next write
 * landing, as a second tab can: everything `other` writes goes first. The
 * returned function runs it now if no write came.
 */
function beforeNextWrite(other: () => void) {
  const pending = { other: other as (() => void) | null };
  const run = () => {
    const next = pending.other;
    pending.other = null;
    next?.();
  };
  for (const method of ["setItem", "removeItem"] as const) {
    const original = Storage.prototype[method] as (...args: string[]) => void;
    vi.spyOn(Storage.prototype, method).mockImplementation(function (this: Storage, ...args: string[]) {
      run();
      original.apply(this, args);
    });
  }
  return run;
}
const draft = (tab: Store, name: string) => ({
  ...tab.newDraft("project-1"),
  name,
  objective: `${name} objective`,
});
type Sent = { name: string; key: string };
const never = () => new Promise<never>(() => {});
const recorder = () => vi.fn((_input: Sent) => never());
const sent = (create: ReturnType<typeof recorder>) =>
  create.mock.calls.map(([input]) => ({ name: input.name, key: input.key }));
const flush = () => act(async () => {});
/** The keys in storage. */
const storedKeys = () => [
  ...new Set(Object.values(window.localStorage).join("").match(/sidebar-create:[a-z0-9]+/g)),
];
/** What a fresh page load sends again: every unsettled key in storage. Clears the recorders. */
async function resumedAfterReload() {
  vi.restoreAllMocks();
  const create = recorder();
  (await openTab()).resumeSubmissions(create, () => {});
  return sent(create).sort((a, b) => a.name.localeCompare(b.name));
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("two tabs that send at the same moment both keep their keys", async () => {
  const a = await openTab();
  const b = await openTab();
  const createA = recorder();
  const createB = recorder();
  // Both tabs read storage before either writes.
  beforeNextWrite(() => b.submitDraft(draft(b, "B"), createB, () => {}));
  a.submitDraft(draft(a, "A"), createA, () => {});
  const expected = [...sent(createA), ...sent(createB)];
  expect(expected.map((s) => s.name)).toEqual(["A", "B"]);
  expect(await resumedAfterReload()).toEqual(expected);
});

it("a success in one tab keeps the key another tab sends meanwhile", async () => {
  const a = await openTab();
  const b = await openTab();
  let finishA!: (value: CreatedInitiative) => void;
  a.submitDraft(draft(a, "A"), () => new Promise((resolve) => (finishA = resolve)), () => {});
  const createB = recorder();
  beforeNextWrite(() => b.submitDraft(draft(b, "B"), createB, () => {}));
  finishA({ write: "done", projectId: "p9", coordinatorThreadId: null, note: null });
  await flush();
  const expected = sent(createB);
  expect(expected.map((s) => s.name)).toEqual(["B"]);
  expect(await resumedAfterReload()).toEqual(expected);
});

it("a resume in another tab never brings back a submission this tab removed", async () => {
  const a = await openTab();
  a.submitDraft(draft(a, "A"), never, () => {});
  const [key] = storedKeys();
  const b = await openTab();
  // Tab B reads A's key to send it again; tab A removes it meanwhile.
  const removeInA = beforeNextWrite(() => a.dismissSubmission(key!));
  b.resumeSubmissions(recorder(), () => {});
  removeInA();
  expect(await resumedAfterReload()).toEqual([]);
});

it("a send without an answer in one tab never brings back what another tab removed", async () => {
  const a = await openTab();
  a.submitDraft(draft(a, "A"), never, () => {});
  const [key] = storedKeys();
  const b = await openTab();
  b.resumeSubmissions(() => Promise.reject(new Error("Connection lost.")), () => {});
  const removeInA = beforeNextWrite(() => a.dismissSubmission(key!));
  await flush();
  removeInA();
  expect(await resumedAfterReload()).toEqual([]);
});

it("a success clears its submission even after another tab expired its key", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const a = await openTab();
  let finishA!: (value: CreatedInitiative) => void;
  const created = vi.fn();
  a.submitDraft(draft(a, "A"), () => new Promise((resolve) => (finishA = resolve)), created);
  vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60_000);
  const b = await openTab();
  const { result } = renderHook(() => b.useSubmissions());
  b.resumeSubmissions(recorder(), () => {});
  await announce();
  expect(result.current.submissions.map((s) => s.error)).toEqual([expect.stringMatching(/over 7 days ago/)]);
  finishA({ write: "done", projectId: "p9", coordinatorThreadId: null, note: null });
  await flush();
  await announce();
  expect(result.current.submissions).toEqual([]);
  expect(created).toHaveBeenCalledTimes(1);
});

it("a tab shows the submissions another tab sends and settles", async () => {
  const a = await openTab();
  const b = await openTab();
  const { result } = renderHook(() => b.useSubmissions());
  let finishA!: (value: CreatedInitiative) => void;
  a.submitDraft(draft(a, "A"), () => new Promise((resolve) => (finishA = resolve)), () => {});
  await announce();
  expect(result.current.submissions.map((s) => [s.draft.name, s.error])).toEqual([["A", null]]);
  finishA({ write: "rejected", message: "Refused." });
  await flush();
  await announce();
  expect(result.current.submissions.map((s) => [s.draft.name, s.error])).toEqual([["A", "Refused."]]);
  // A settled key is not sent again on reload.
  expect(await resumedAfterReload()).toEqual([]);
});

it("keeps submissions in memory when storage refuses writes", async () => {
  const tab = await openTab();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Quota exceeded", "QuotaExceededError");
  });
  const { result } = renderHook(() => tab.useSubmissions());
  const create = recorder();
  act(() => tab.submitDraft(draft(tab, "A"), create, () => {}));
  expect(result.current.submissions.map((s) => [s.draft.name, s.key])).toEqual([
    ["A", sent(create)[0]!.key],
  ]);
});
