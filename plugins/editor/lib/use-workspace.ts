/**
 * Resolves which workspace a thread (or project checkout) points at. The
 * panel keeps the last good resolution of the SAME target visible across a
 * failed refresh — its source identity is still the right one — and marks it
 * stale with `refreshError`. A different target never sees another
 * workspace's resolution.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc, type PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";

export interface InspectionGate {
  /** True while the foreign workspace may only be read and mirrored. */
  inspecting: boolean;
  /** Displayed opt-in state; false while the resolution is stale or failed. */
  editingEnabled: boolean;
  setEditingEnabled: (next: boolean) => void;
}

/**
 * The edit opt-in for a foreign workspace. It is bound to the resolved
 * source identity, not the thread id: a retained last-good resolution is
 * inspection-only evidence while it is stale or in error, and a target
 * whose environment resolves differently — even under the same
 * `targetThreadId` — drops the previous opt-in so enabling edit is always a
 * deliberate act against the real source.
 */
export function useInspectionGate(targetThreadId: string, foreign: boolean, workspace: WorkspaceState): InspectionGate {
  const [enabled, setEnabled] = useState(false);
  const environmentId = workspace.kind === "ready" ? (workspace.source.environmentId ?? null) : null;
  const fresh = workspace.kind === "ready" && workspace.refreshError === null;
  useEffect(() => setEnabled(false), [targetThreadId, environmentId]);
  const active = enabled && fresh;
  return { inspecting: foreign && !active, editingEnabled: active, setEditingEnabled: setEnabled };
}

export type WorkspaceState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      /** The request this resolution answered — `threadId`/`projectId`. */
      key: string;
      source: PluginFileOpenerSource;
      root: string;
      label: string;
      refreshError: string | null;
    };

export function useWorkspace(threadId: string | null, projectId: string | null): WorkspaceState & { refresh: () => void } {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  // A response is only allowed to land while it is the newest request AND
  // the effect has not cleaned up: a late answer from a previous target or
  // retry cannot retarget the panel or arm a stale source's writes.
  const generation = useRef(0);
  const key = `${threadId ?? "thread-none"}:${projectId ?? "project-none"}`;
  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    // A same-target re-resolution keeps its last answer visible while it
    // runs; a different target must never see another workspace's files.
    setState((current) => (current.kind === "ready" && current.key === key ? current : { kind: "loading" }));
    void rpc
      .call("workspace", { threadId, projectId })
      .then((result) => {
        if (mine !== generation.current) return;
        setState({ kind: "ready", key, ...result, refreshError: null });
      })
      .catch((error: unknown) => {
        if (mine !== generation.current) return;
        const message = error instanceof Error ? error.message : "Could not resolve the workspace";
        setState((current) =>
          current.kind === "ready" && current.key === key ? { ...current, refreshError: message } : { kind: "error", message },
        );
      });
    return () => {
      generation.current += 1;
    };
  }, [rpc, threadId, projectId, nonce, key]);
  return { ...state, refresh };
}
