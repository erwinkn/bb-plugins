import { useSyncExternalStore } from "react";
import {
  STATUSES,
  type Status,
  type SortBy,
  type SortDirection,
} from "./status";

/** Grouping and order of the Other threads list, local to this client. */
export interface ThreadListing {
  groupBy: "none" | "status" | "project";
  sortBy: SortBy;
  sortDirection: SortDirection;
}

/** Grouping and order of the selected Adventure's worker rows, local to this client. */
export interface WorkerListing {
  groupBy: "state" | "none";
  /** Most recent activity first, or the newest worker (highest W#) first. */
  sortBy: "updated" | "worker";
}

export interface ClientState {
  listing: ThreadListing;
  workerListing: WorkerListing;
  /**
   * What the section below the Adventures lists: an Adventure's id (its
   * workers) or OTHER_THREADS. Null before the first pick.
   */
  selected: string | null;
  hidden: Status[];
  showArchives: boolean;
  showSnoozed: boolean;
  collapsed: string[];
  drafts: string[];
  expandedArchives: string[];
}
/** The `selected` value of the Other threads entry. */
export const OTHER_THREADS = "other-threads";
/**
 * Local-storage key of this client's state. Fields of removed features (the
 * view switch's `mode`, the Threads view's grouping and order, `spaceId`,
 * the open Adventures, the folded Other threads entry) may linger in it;
 * parsing drops them.
 */
const KEY = "bb-plugin-sidebar:v1";
export const DEFAULT_LISTING: ThreadListing = {
  groupBy: "none",
  sortBy: "updated",
  sortDirection: "descending",
};
export const DEFAULT_WORKER_LISTING: WorkerListing = {
  groupBy: "state",
  sortBy: "updated",
};
const DEFAULT: ClientState = {
  listing: DEFAULT_LISTING,
  workerListing: DEFAULT_WORKER_LISTING,
  selected: null,
  hidden: [],
  showArchives: false,
  showSnoozed: true,
  collapsed: [],
  drafts: [],
  expandedArchives: [],
};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === "string"))]
    : [];

function parseListing(value: unknown): ThreadListing {
  if (!value || typeof value !== "object") return DEFAULT_LISTING;
  const listing = value as Record<string, unknown>;
  return {
    groupBy:
      listing.groupBy === "status" || listing.groupBy === "project"
        ? listing.groupBy
        : "none",
    sortBy: listing.sortBy === "created" ? "created" : "updated",
    sortDirection:
      listing.sortDirection === "ascending" ? "ascending" : "descending",
  };
}

function parseWorkerListing(value: unknown): WorkerListing {
  if (!value || typeof value !== "object") return DEFAULT_WORKER_LISTING;
  const listing = value as Record<string, unknown>;
  return {
    groupBy: listing.groupBy === "none" ? "none" : "state",
    sortBy: listing.sortBy === "worker" ? "worker" : "updated",
  };
}

export function parseState(raw: string | null): ClientState {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return DEFAULT;
    return {
      // Stored as `initiativesListing` while it belonged to one of two views.
      listing: parseListing(value.listing ?? value.initiativesListing),
      workerListing: parseWorkerListing(value.workerListing),
      selected: typeof value.selected === "string" ? value.selected : null,
      hidden: strings(value.hidden).filter((s): s is Status =>
        STATUSES.includes(s as Status),
      ),
      showArchives: value.showArchives === true,
      showSnoozed: value.showSnoozed !== false,
      collapsed: strings(value.collapsed).filter((key) => key !== OTHER_THREADS),
      expandedArchives: strings(value.expandedArchives),
      drafts: strings(value.drafts).filter(
        (key) => key.startsWith("thread:") || key.startsWith("new:"),
      ),
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
