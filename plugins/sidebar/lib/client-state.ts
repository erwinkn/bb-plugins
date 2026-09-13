import { useSyncExternalStore } from "react";
import {
  STATUSES,
  type Status,
  type SortBy,
  type SortDirection,
} from "./status";

export interface ClientState {
  groupBy: "status" | "project";
  sortBy: SortBy;
  sortDirection: SortDirection;
  hidden: Status[];
  showArchives: boolean;
  collapsed: string[];
  drafts: string[];
  expandedArchives: string[];
  /** Selected saved space; an id missing from the catalog means All projects. */
  spaceId: string | null;
}
/** Local-storage key of this client's state. Other plugins may write `spaceId` here. */
export const CLIENT_STATE_KEY = "bb-plugin-sidebar:v1";
const KEY = CLIENT_STATE_KEY;
/**
 * Same-window change signal. A `storage` event only fires in other windows, so
 * a plugin that writes this state in the same page dispatches this event after
 * the write; the store re-reads storage and re-renders.
 */
export const CLIENT_STATE_EVENT = "bb-plugin-sidebar:state";
const DEFAULT: ClientState = {
  groupBy: "status",
  sortBy: "updated",
  sortDirection: "descending",
  hidden: [],
  showArchives: false,
  collapsed: [],
  drafts: [],
  expandedArchives: [],
  spaceId: null,
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
      sortDirection:
        value.sortDirection === "ascending" ? "ascending" : "descending",
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
        typeof value.spaceId === "string" && value.spaceId
          ? value.spaceId
          : null,
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
function onExternalChange() {
  if (pendingWrite) return;
  state = readState(state);
  emit();
}
function subscribe(listener: () => void) {
  if (!listeners.size) {
    window.addEventListener("storage", onStorage);
    window.addEventListener(CLIENT_STATE_EVENT, onExternalChange);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CLIENT_STATE_EVENT, onExternalChange);
    }
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
