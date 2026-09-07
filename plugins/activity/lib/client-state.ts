import { useSyncExternalStore } from "react";
import { STATUSES, type Status, type SortBy } from "./status";

export interface ClientState {
  groupBy: "status" | "project";
  sortBy: SortBy;
  hidden: Status[];
  showArchives: boolean;
  collapsed: string[];
  drafts: string[];
  expandedArchives: string[];
  /** Selected saved space; an id missing from the catalog means All projects. */
  spaceId: string | null;
  /** Ad-hoc project selection used while no saved space is selected. */
  projectIds: string[];
}
const KEY = "bb-plugin-erwin-activity:v1";
const DEFAULT: ClientState = {
  groupBy: "status",
  sortBy: "updated",
  hidden: [],
  showArchives: false,
  collapsed: [],
  drafts: [],
  expandedArchives: [],
  spaceId: null,
  projectIds: [],
};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === "string"))]
    : [];

export function parseState(raw: string | null): ClientState {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return DEFAULT;
    return {
      groupBy: value.groupBy === "project" ? "project" : "status",
      sortBy: value.sortBy === "created" ? "created" : "updated",
      hidden: strings(value.hidden).filter((s): s is Status =>
        STATUSES.includes(s as Status),
      ),
      showArchives: value.showArchives === true,
      collapsed: strings(value.collapsed),
      expandedArchives: strings(value.expandedArchives),
      drafts: strings(value.drafts).filter(
        (key) => key.startsWith("thread:") || key.startsWith("new:"),
      ),
      spaceId:
        typeof value.spaceId === "string" && value.spaceId ? value.spaceId : null,
      projectIds: strings(value.projectIds).filter(Boolean),
    };
  } catch {
    return DEFAULT;
  }
}
function readState(fallback = DEFAULT): ClientState {
  try {
    return parseState(window.localStorage.getItem(KEY));
  } catch {
    return fallback;
  }
}
let state = readState();
let pendingWrite = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
function onStorage(event: StorageEvent) {
  if (event.key === KEY || event.key === null) {
    // A failed write leaves this tab's snapshot ahead of storage. Do not
    // discard it in response to another tab; retry on the next local update.
    if (pendingWrite) return;
    state = readState(state);
    emit();
  }
}
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}
export function useClientState() {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => DEFAULT,
  );
}
export function updateState(change: (current: ClientState) => ClientState) {
  // Merge with the last stored state so another window's flags are preserved.
  let current = state;
  if (!pendingWrite) {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw !== null) current = parseState(raw);
    } catch {
      /* Memory-only mode. */
    }
  }
  const next = change(current);
  const serialized = JSON.stringify(next);
  const changed = serialized !== JSON.stringify(state);
  // Compare with both baselines. A stale in-memory snapshot can match next
  // even though the persisted value needs to change.
  if (!changed && serialized === JSON.stringify(current) && !pendingWrite)
    return;
  state = next;
  try {
    window.localStorage.setItem(KEY, serialized);
    pendingWrite = false;
  } catch {
    pendingWrite = true;
  }
  if (changed) emit();
}
export function recordDraft(key: string, present: boolean) {
  updateState((current) => ({
    ...current,
    drafts: present
      ? [...new Set([...current.drafts, key])]
      : current.drafts.filter((id) => id !== key),
  }));
}
export function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}
