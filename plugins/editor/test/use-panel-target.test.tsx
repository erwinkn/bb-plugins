/**
 * The pick→persist queue must compute each step's expected params from the
 * last positive receipt, inside the step — not from what the tab looked like
 * when the user clicked. Rapid picks chain target→target so the last pick is
 * the persisted winner; stale captures can never rewrite a newer target.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

type Call = { method: string; input: Record<string, unknown> };

let calls: Call[] = [];
let resolves: Array<() => void> = [];
let respond: (method: string, input: Call["input"]) => unknown = () => ({ persisted: true, reason: null });
let fail = false;
/**
 * Per-tab persistence truth: a `setPanelTarget` write lands only when
 * `expectedParams` matches what the tab really holds, else it declines with
 * the truth — the same CAS contract the real handler gives. Tabs are keyed
 * by actionId so Files and Changes persist independently.
 */
let disk: Record<string, unknown> = {};
// Stable across renders: hooks put the rpc in effect deps, so a fresh
// object per render would re-run them forever.
const rpc = {
  call: (method: string, input: Call["input"]) => {
    calls.push({ method, input });
    return new Promise((resolve, reject) => {
      resolves.push(() => {
        if (fail) return reject(new Error("rpc failed"));
        if (method === "setPanelTarget") {
          const actionId = String(input.actionId);
          const held = disk[actionId] ?? null;
          if (sameJson(input.expectedParams, held)) {
            disk[actionId] = input.params;
            return resolve({ persisted: true, reason: null });
          }
          return resolve({ persisted: false, reason: "tab moved", currentParams: held });
        }
        return resolve(respond(method, input));
      });
    });
  },
};
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => rpc }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
// The dirty-guard imports reach the session registry; the hook under test
// only needs the persist half, so the file-session side is stubbed inert.
vi.mock("@/lib/file-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/file-session")>();
  return { ...actual };
});
vi.mock("@/lib/use-file-session", () => ({ useDirtyPaths: () => new Set<string>() }));

import { sameJson } from "@/lib/panel-target";
import { usePanelTarget, useWorkspaces } from "@/lib/use-panel-target";
import { useInspectionGate, useWorkspace } from "@/lib/use-workspace";

function setup(params: unknown = null) {
  return renderHook(({ params: p }: { params: unknown }) => usePanelTarget("thr_own", p, "files"), {
    initialProps: { params },
    wrapper: ({ children }: { children: ReactNode }) => <>{children}</>,
  });
}

/**
 * Drain the microtask queue, resolving any rpc calls the steps have reached.
 * Each pass can queue the next step's call, so loop until nothing new lands.
 */
const settle = async () => {
  for (let i = 0; i < 10; i += 1) {
    resolves.splice(0).forEach((done) => done());
    for (let t = 0; t < 5; t += 1) await Promise.resolve();
    if (resolves.length === 0 && i > 2) break;
  }
};

describe("usePanelTarget persistence queue", () => {
  it("chains expected params from the last positive receipt on rapid picks", async () => {
    calls = [];
    resolves = [];
    disk = {};
    const { result } = setup(null);
    act(() => {
      result.current.switchTarget("thr_w16");
      result.current.switchTarget("thr_w21");
    });
    // Let the queued steps reach the rpc, then let them finish in order.
    await act(async () => {
      await settle();
    });
    expect(calls.length).toBe(2);
    expect(calls[0]!.input.expectedParams).toBeNull();
    expect(calls[0]!.input.params).toEqual({ targetThreadId: "thr_w16" });
    // The second pick's expected is the first pick's persisted result,
    // computed when the step ran — not the click-time null.
    expect(calls[1]!.input.expectedParams).toEqual({ targetThreadId: "thr_w16" });
    expect(calls[1]!.input.params).toEqual({ targetThreadId: "thr_w21" });
  });

  it("skips a queued step whose params already match the last receipt", async () => {
    calls = [];
    resolves = [];
    disk = {};
    const { result } = setup(null);
    act(() => {
      result.current.switchTarget("thr_w16");
      result.current.switchTarget("thr_w16");
    });
    await act(async () => {
      await settle();
    });
    expect(calls.length).toBe(1);
  });

  it("keeps a foreign target from stale props from silently winning", async () => {
    calls = [];
    resolves = [];
    disk = {};
    const { result, rerender } = setup({ targetThreadId: "thr_w16" });
    expect(result.current.targetThreadId).toBe("thr_w16");
    // A late props update for the same tab state does not retarget.
    rerender({ params: { targetThreadId: "thr_w16" } });
    expect(result.current.targetThreadId).toBe("thr_w16");
    // A genuinely different persisted target does (another writer's rewrite).
    rerender({ params: { targetThreadId: "thr_w21" } });
    expect(result.current.targetThreadId).toBe("thr_w21");
  });
});

/**
 * Props are an unordered channel: BB can deliver the tab's params out of
 * order. The hook keeps an issued/receipt ledger — a props event naming a
 * target an already-confirmed pick superseded is a stale echo, and neither
 * the visible target nor the persisted-state receipt may regress to it.
 */
describe("usePanelTarget receipt reconciliation", () => {
  it("a delayed older props delivery cannot roll back a newer confirmed target", async () => {
    calls = [];
    resolves = [];
    disk = {};
    const { result, rerender } = setup(null);
    act(() => {
      result.current.switchTarget("thr_w16");
      result.current.switchTarget("thr_w21");
    });
    await act(async () => {
      await settle();
    });
    expect(calls.length).toBe(2);
    // The confirmed write's echo arrives, then a delayed echo of the first
    // pick. Disk still says w21, so the revalidation declines and the A
    // echo cannot move anything.
    rerender({ params: { targetThreadId: "thr_w21" } });
    rerender({ params: { targetThreadId: "thr_w16" } });
    await act(async () => {
      await settle();
    });
    expect(result.current.targetThreadId).toBe("thr_w21");
    // The next pick still chains from the true receipt, so it persists.
    act(() => {
      result.current.switchTarget("thr_w9");
    });
    await act(async () => {
      await settle();
    });
    expect(calls.at(-1)!.input.expectedParams).toEqual({ targetThreadId: "thr_w21" });
    expect(calls.at(-1)!.input.params).toEqual({ targetThreadId: "thr_w9" });
  });

  it("adopts genuine external navigation back to a previously picked target, including a new path", async () => {
    calls = [];
    resolves = [];
    disk = {};
    const { result, rerender } = setup(null);
    act(() => {
      result.current.switchTarget("thr_a");
      result.current.switchTarget("thr_b");
    });
    await act(async () => {
      await settle();
    });
    rerender({ params: { targetThreadId: "thr_b" } });
    // Something else really rewrote the tab back to A with a new path —
    // the disk model holds it, so the identity revalidation persists and
    // the navigation is adopted instead of read as a stale echo.
    disk = { files: { targetThreadId: "thr_a", path: "src/new.ts" } };
    rerender({ params: { targetThreadId: "thr_a", path: "src/new.ts" } });
    await act(async () => {
      await settle();
    });
    expect(result.current.targetThreadId).toBe("thr_a");
    // The adopted receipt is the chaining point for the next pick.
    act(() => {
      result.current.switchTarget("thr_c");
    });
    await act(async () => {
      await settle();
    });
    expect(calls.at(-1)!.input.expectedParams).toEqual({ targetThreadId: "thr_a", path: "src/new.ts" });
    expect(calls.at(-1)!.input.params).toEqual({ targetThreadId: "thr_c" });
  });

  it("suppresses an older in-flight echo while a newer pick is still pending", async () => {
    calls = [];
    resolves = [];
    disk = {};
    const { result, rerender } = setup(null);
    act(() => {
      result.current.switchTarget("thr_w16");
      result.current.switchTarget("thr_w21");
    });
    // Before either rpc resolves, the tab echoes the first pick's write.
    rerender({ params: { targetThreadId: "thr_w16" } });
    expect(result.current.targetThreadId).toBe("thr_w21");
    await act(async () => {
      await settle();
    });
    expect(result.current.targetThreadId).toBe("thr_w21");
  });

  it("adopts the server's current params on a decline so the next pick chains again", async () => {
    calls = [];
    resolves = [];
    disk = { files: { targetThreadId: "thr_disk" } };
    const { result } = setup(null);
    act(() => {
      result.current.switchTarget("thr_w16");
    });
    await act(async () => {
      await settle();
    });
    act(() => {
      result.current.switchTarget("thr_w9");
    });
    await act(async () => {
      await settle();
    });
    expect(calls.length).toBe(2);
    expect(calls[1]!.input.expectedParams).toEqual({ targetThreadId: "thr_disk" });
  });

  it("accepts a genuinely external navigation to a never-picked target", async () => {
    calls = [];
    resolves = [];
    disk = {};
    const { result, rerender } = setup(null);
    act(() => {
      result.current.switchTarget("thr_w16");
    });
    await act(async () => {
      await settle();
    });
    disk = { files: { targetThreadId: "thr_w33" } };
    rerender({ params: { targetThreadId: "thr_w33" } });
    expect(result.current.targetThreadId).toBe("thr_w33");
    // And the ledger adopts it: a subsequent pick chains from it.
    act(() => {
      result.current.switchTarget("thr_w16");
    });
    await act(async () => {
      await settle();
    });
    expect(calls.at(-1)!.input.expectedParams).toEqual({ targetThreadId: "thr_w33" });
  });

  it("keeps Files and Changes ledgers independent", async () => {
    calls = [];
    resolves = [];
    disk = {};
    const files = renderHook(({ params }: { params: unknown }) => usePanelTarget("thr_own", params, "files"), { initialProps: { params: null } });
    const changes = renderHook(({ params }: { params: unknown }) => usePanelTarget("thr_own", params, "changes"), {
      initialProps: { params: null },
    });
    act(() => {
      files.result.current.switchTarget("thr_w16");
      changes.result.current.switchTarget("thr_w21");
    });
    await act(async () => {
      await settle();
    });
    expect(files.result.current.targetThreadId).toBe("thr_w16");
    expect(changes.result.current.targetThreadId).toBe("thr_w21");
    // Each tab wrote only its own params.
    const fileCalls = calls.filter((call) => (call.input as { actionId?: string }).actionId === "files");
    const changeCalls = calls.filter((call) => (call.input as { actionId?: string }).actionId === "changes");
    expect(fileCalls.length).toBe(1);
    expect(changeCalls.length).toBe(1);
  });
});

/**
 * A failed refresh must not erase the evidence it was refreshing: the last
 * good entries stay listed, marked by the error, and Retry reloads both the
 * list and the selected workspace.
 */
describe("useWorkspaces refresh failures", () => {
  it("retains last-good entries across a failed refresh and recovers on retry", async () => {
    calls = [];
    resolves = [];
    disk = {};
    fail = false;
    const entries = [
      { threadId: "thr_own", role: "coordinator", label: "Coordinator", available: true },
      { threadId: "thr_w16", role: "worker", workerRef: "W16", label: "Fix clipping", available: true },
    ];
    respond = () => ({ coordinatorThreadId: "thr_own", named: true, degraded: null, entries });
    const { result } = renderHook(() => useWorkspaces("thr_own"));
    await act(async () => {
      await settle();
    });
    expect(result.current.kind).toBe("ready");
    expect(result.current.entries.length).toBe(2);

    act(() => {
      fail = true;
      result.current.refresh();
    });
    await act(async () => {
      await settle();
    });
    expect(result.current.kind).toBe("error");
    expect(result.current.message).toContain("rpc failed");
    // The retained rows — the selected one among them must not vanish.
    expect(result.current.entries.length).toBe(2);
    expect(result.current.coordinatorThreadId).toBe("thr_own");

    act(() => {
      fail = false;
      result.current.refresh();
    });
    await act(async () => {
      await settle();
    });
    expect(result.current.kind).toBe("ready");
    expect(result.current.message).toBeNull();
  });

  it("a degraded Projects answer keeps last-good exact rows its native fallback lost", async () => {
    calls = [];
    resolves = [];
    disk = {};
    fail = false;
    const exact = {
      coordinatorThreadId: "thr_own",
      named: true,
      degraded: null,
      entries: [
        { threadId: "thr_own", role: "coordinator", label: "Coordinator", available: true },
        // A cross-repo member only the tree knows — the degraded refresh's
        // native fallback does not include it.
        { threadId: "thr_cross", role: "worker", workerRef: "W8", label: "Cross repo", available: true },
      ],
    };
    const degraded = {
      coordinatorThreadId: "thr_own",
      named: true,
      degraded: "The Projects tree could not be read; names are native fallbacks.",
      entries: [{ threadId: "thr_own", role: "coordinator", label: "Coordinator", available: true }],
    };
    let response = exact;
    respond = () => response;
    const { result } = renderHook(() => useWorkspaces("thr_own"));
    await act(async () => {
      await settle();
    });
    expect(result.current.entries.some((entry) => entry.threadId === "thr_cross")).toBe(true);

    response = degraded;
    act(() => result.current.refresh());
    await act(async () => {
      await settle();
    });
    expect(result.current.degraded).not.toBeNull();
    expect(result.current.entries.some((entry) => entry.threadId === "thr_cross")).toBe(true);

    // A healthy tree proves the member is gone and the row finally drops.
    response = { ...exact, entries: [exact.entries[0]!] };
    act(() => result.current.refresh());
    await act(async () => {
      await settle();
    });
    expect(result.current.degraded).toBeNull();
    expect(result.current.entries.some((entry) => entry.threadId === "thr_cross")).toBe(false);
  });
});

/**
 * The selected-workspace resolution obeys the same rules: a same-target
 * failure keeps the last ready answer marked stale, a Retry re-resolves it,
 * and a late response from a previous target can never land.
 */
describe("useWorkspace resolution", () => {
  it("keeps a same-target resolution marked stale across a failed refresh, then recovers", async () => {
    calls = [];
    resolves = [];
    fail = false;
    respond = () => ({ source: { kind: "workspace", threadId: "thr_w16" }, root: "/ws/b", label: "B" });
    const { result } = renderHook(() => useWorkspace("thr_w16", null));
    await act(async () => {
      await settle();
    });
    expect(result.current.kind).toBe("ready");

    act(() => {
      fail = true;
      result.current.refresh();
    });
    await act(async () => {
      await settle();
    });
    // Still ready — for the same target — but carrying the failure.
    expect(result.current.kind).toBe("ready");
    if (result.current.kind === "ready") {
      expect(result.current.refreshError).toContain("rpc failed");
      expect(result.current.root).toBe("/ws/b");
    }

    act(() => {
      fail = false;
      result.current.refresh();
    });
    await act(async () => {
      await settle();
    });
    expect(result.current.kind).toBe("ready");
    if (result.current.kind === "ready") expect(result.current.refreshError).toBeNull();
  });

  it("a target switch never shows the previous workspace, even while resolving", async () => {
    calls = [];
    resolves = [];
    fail = false;
    respond = (_method, input) => ({
      source: { kind: "workspace", threadId: input.threadId },
      root: `/ws/${String(input.threadId)}`,
      label: String(input.threadId),
    });
    const { result, rerender } = renderHook(({ threadId }: { threadId: string | null }) => useWorkspace(threadId, null), {
      initialProps: { threadId: "thr_w16" },
    });
    await act(async () => {
      await settle();
    });
    expect(result.current.kind).toBe("ready");

    // Switch target: the previous ready must not leak — the panel loads.
    rerender({ threadId: "thr_w21" });
    expect(result.current.kind).toBe("loading");
    await act(async () => {
      await settle();
    });
    expect(result.current.kind).toBe("ready");
    if (result.current.kind === "ready") expect(result.current.root).toBe("/ws/thr_w21");
  });
});

/**
 * The edit opt-in binds to the resolved environment, not the thread id: a
 * stale retained resolution revokes it, and a target whose environment
 * resolves differently — even under the same thread id — needs a fresh,
 * deliberate opt-in.
 */
describe("useInspectionGate", () => {
  const ready = (environmentId: string, refreshError: string | null = null) => ({
    kind: "ready" as const,
    key: `thr_a:null`,
    source: { kind: "workspace" as const, threadId: "thr_a", environmentId, projectId: "proj" },
    root: "/ws",
    label: "label",
    refreshError,
  });

  it("revokes the opt-in while the resolution is stale and restores it after recovery", async () => {
    const { result, rerender } = renderHook(
      ({ ws, foreign }: { ws: Parameters<typeof useInspectionGate>[2]; foreign: boolean }) => useInspectionGate("thr_a", foreign, ws),
      { initialProps: { ws: ready("env_old"), foreign: true } },
    );
    expect(result.current.inspecting).toBe(true);
    act(() => result.current.setEditingEnabled(true));
    expect(result.current.inspecting).toBe(false);
    expect(result.current.editingEnabled).toBe(true);

    // The retained resolution goes stale: the opt-in stops applying even
    // though the underlying enabled flag is still set.
    rerender({ ws: ready("env_old", "environment lookup failed"), foreign: true });
    expect(result.current.inspecting).toBe(true);
    expect(result.current.editingEnabled).toBe(false);

    // Recovery restores the opted-in state — the environment is unchanged.
    rerender({ ws: ready("env_old"), foreign: true });
    expect(result.current.inspecting).toBe(false);
  });

  it("a changed environment under the same target drops the opt-in entirely", async () => {
    const { result, rerender } = renderHook(
      ({ ws, foreign }: { ws: Parameters<typeof useInspectionGate>[2]; foreign: boolean }) => useInspectionGate("thr_a", foreign, ws),
      { initialProps: { ws: ready("env_old"), foreign: true } },
    );
    act(() => result.current.setEditingEnabled(true));
    expect(result.current.editingEnabled).toBe(true);

    // Same targetThreadId, different environment: a deliberate re-opt-in.
    rerender({ ws: ready("env_new"), foreign: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.editingEnabled).toBe(false);
    expect(result.current.inspecting).toBe(true);
  });

  it("a resolution error keeps the foreign workspace inspection-only", async () => {
    const { result, rerender } = renderHook(
      ({ ws, foreign }: { ws: Parameters<typeof useInspectionGate>[2]; foreign: boolean }) => useInspectionGate("thr_a", foreign, ws),
      { initialProps: { ws: ready("env_old"), foreign: true } },
    );
    act(() => result.current.setEditingEnabled(true));
    rerender({ ws: { kind: "error" as const, message: "gone" }, foreign: true });
    expect(result.current.inspecting).toBe(true);
  });
});
