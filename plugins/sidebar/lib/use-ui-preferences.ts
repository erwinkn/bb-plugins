import { useCallback, useEffect, useRef } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { uiPreferencesContract } from "./ui-preferences-contract";
import {
  UI_PREFERENCES_CHANNEL,
  syncedPreferenceEntrySchema,
  type SyncedKey,
  type SyncedPreferenceWrite,
  type SyncedPreferences,
} from "./ui-preferences-schema";
import {
  updateState,
  useClientState,
  type ClientState,
} from "./client-state";
import type { SortBy, SortDirection } from "./status";

// The plugin-side view of the BB preferences it mirrors. Status grouping,
// hidden statuses, archive visibility, spaces, and the library stay local.
interface Mirror {
  groupBy: ClientState["groupBy"];
  sortBy: SortBy;
  sortDirection: SortDirection;
  pinnedCollapsed: boolean;
  collapsedProjects: string[];
}

const PROJECT_PREFIX = "project:";

function projectionOf(state: ClientState): Mirror {
  return {
    groupBy: state.groupBy,
    sortBy: state.sortBy,
    sortDirection: state.sortDirection,
    pinnedCollapsed: state.collapsed.includes("pinned"),
    collapsedProjects: state.collapsed
      .filter((key) => key.startsWith(PROJECT_PREFIX))
      .map((key) => key.slice(PROJECT_PREFIX.length))
      .sort(),
  };
}

// BB's project mode is the plugin's Project grouping. Chronological and
// machine modes have no plugin equivalent, so both show Status grouping.
function mirrorOf(host: SyncedPreferences, current: ClientState): Mirror {
  const sort = host["sidebar.chronologicalSort"].value;
  return {
    groupBy:
      host["sidebar.organizationMode"].value === "project"
        ? "project"
        : "status",
    // Alphabetical and manual orders are not offered here; keep the local
    // date sort until the user picks one.
    sortBy: sort === "created" || sort === "updated" ? sort : current.sortBy,
    sortDirection:
      host["sidebar.sortDirection"].value === "ascending"
        ? "ascending"
        : "descending",
    pinnedCollapsed: host["sidebar.collapsedSections"].value.includes("pinned"),
    collapsedProjects: [...host["sidebar.collapsedProjects"].value].sort(),
  };
}

function applyMirror(current: ClientState, mirror: Mirror): ClientState {
  const collapsed = current.collapsed.filter(
    (key) => key !== "pinned" && !key.startsWith(PROJECT_PREFIX),
  );
  if (mirror.pinnedCollapsed) collapsed.push("pinned");
  for (const id of mirror.collapsedProjects)
    collapsed.push(`${PROJECT_PREFIX}${id}`);
  return {
    ...current,
    groupBy: mirror.groupBy,
    sortBy: mirror.sortBy,
    sortDirection: mirror.sortDirection,
    collapsed,
  };
}

// One local change becomes one BB write, computed against the latest known
// host value so entries the plugin does not show (other projects, the
// Threads section) survive.
function writeFor(
  key: SyncedKey,
  host: SyncedPreferences,
  previous: Mirror,
  next: Mirror,
): SyncedPreferenceWrite {
  const expectedRevision = host[key].revision;
  switch (key) {
    case "sidebar.organizationMode":
      return {
        key,
        expectedRevision,
        value: next.groupBy === "project" ? "project" : "chronological",
      };
    case "sidebar.chronologicalSort":
      return { key, expectedRevision, value: next.sortBy };
    case "sidebar.sortDirection":
      return { key, expectedRevision, value: next.sortDirection };
    case "sidebar.collapsedSections": {
      const rest = host[key].value.filter((id) => id !== "pinned");
      return {
        key,
        expectedRevision,
        value: next.pinnedCollapsed ? [...rest, "pinned"] : rest,
      };
    }
    case "sidebar.collapsedProjects": {
      const before = new Set(previous.collapsedProjects);
      const after = new Set(next.collapsedProjects);
      const removed = new Set([...before].filter((id) => !after.has(id)));
      const added = [...after].filter((id) => !before.has(id));
      const kept = host[key].value.filter((id) => !removed.has(id));
      return {
        key,
        expectedRevision,
        value: [...kept, ...added.filter((id) => !kept.includes(id))],
      };
    }
  }
}

function changedKeys(previous: Mirror, next: Mirror): SyncedKey[] {
  const keys: SyncedKey[] = [];
  if (previous.groupBy !== next.groupBy) keys.push("sidebar.organizationMode");
  if (previous.sortBy !== next.sortBy) keys.push("sidebar.chronologicalSort");
  if (previous.sortDirection !== next.sortDirection)
    keys.push("sidebar.sortDirection");
  if (previous.pinnedCollapsed !== next.pinnedCollapsed)
    keys.push("sidebar.collapsedSections");
  if (previous.collapsedProjects.join() !== next.collapsedProjects.join())
    keys.push("sidebar.collapsedProjects");
  return keys;
}

const newer = <E extends { revision: number }>(a: E, b: E): E =>
  a.revision > b.revision ? a : b;

// Snapshots can arrive out of order (a slow read answering after a realtime
// update), so merge per key and never roll a key back to an older revision.
function mergeSnapshot(
  current: SyncedPreferences | null,
  next: SyncedPreferences,
): SyncedPreferences {
  if (!current) return next;
  return {
    "sidebar.organizationMode": newer(
      current["sidebar.organizationMode"],
      next["sidebar.organizationMode"],
    ),
    "sidebar.chronologicalSort": newer(
      current["sidebar.chronologicalSort"],
      next["sidebar.chronologicalSort"],
    ),
    "sidebar.sortDirection": newer(
      current["sidebar.sortDirection"],
      next["sidebar.sortDirection"],
    ),
    "sidebar.collapsedSections": newer(
      current["sidebar.collapsedSections"],
      next["sidebar.collapsedSections"],
    ),
    "sidebar.collapsedProjects": newer(
      current["sidebar.collapsedProjects"],
      next["sidebar.collapsedProjects"],
    ),
  };
}

// The mirror only advances once the host acknowledges a value; pending keys
// keep their local value on top of any host snapshot until then.
function advanceMirror(ack: Mirror, key: SyncedKey, next: Mirror): Mirror {
  switch (key) {
    case "sidebar.organizationMode":
      return { ...ack, groupBy: next.groupBy };
    case "sidebar.chronologicalSort":
      return { ...ack, sortBy: next.sortBy };
    case "sidebar.sortDirection":
      return { ...ack, sortDirection: next.sortDirection };
    case "sidebar.collapsedSections":
      return { ...ack, pinnedCollapsed: next.pinnedCollapsed };
    case "sidebar.collapsedProjects":
      return { ...ack, collapsedProjects: next.collapsedProjects };
  }
}

function pendingMirror(ack: Mirror, pending: Map<SyncedKey, Mirror>): Mirror {
  let target = ack;
  for (const [key, next] of pending) target = advanceMirror(target, key, next);
  return target;
}

/**
 * Keeps grouping, date sort, sort direction, and the collapsed Pinned and
 * project groups in step with BB's synced sidebar preferences. BB is the
 * source of truth once read; localStorage stays the cache and the fallback
 * while the server is unreachable. Reads happen on mount, on reconnect, and
 * when the window regains focus, since BB's own clients write these keys
 * without any signal the plugin frontend can subscribe to.
 */
export function useUiPreferences(onError: (error: unknown) => void) {
  const rpc = useRpc<typeof uiPreferencesContract>();
  const connection = useRealtimeConnectionState();
  const state = useClientState();
  const host = useRef<SyncedPreferences | null>(null);
  // The plugin-side values the host last agreed with. A local change is a
  // difference from this; it only advances once a write is acknowledged.
  const mirror = useRef<Mirror | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  // Writes run one at a time so revisions chain correctly. Local values
  // whose write has not been acknowledged stay pending and are retried on
  // the next host snapshot instead of being silently dropped.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(new Map<SyncedKey, Mirror>());

  const flushPending = useCallback(() => {
    if (!host.current || !mirror.current) return;
    for (const [key, next] of pending.current) {
      queue.current = queue.current.then(async () => {
        if (!pending.current.has(key)) return;
        const attempt = async (retry: boolean): Promise<void> => {
          if (!host.current || !mirror.current) return;
          try {
            const entry = await rpc.call(
              "uiPreferences.write",
              writeFor(key, host.current, mirror.current, next),
            );
            host.current = {
              ...host.current,
              [entry.key]: { revision: entry.revision, value: entry.value },
            };
            pending.current.delete(key);
            mirror.current = advanceMirror(mirror.current, key, next);
          } catch (cause) {
            if (!retry) {
              errorRef.current(cause);
              return;
            }
            // Another client changed this key first: retry once against
            // its revision, keeping the local change on top.
            try {
              host.current = mergeSnapshot(
                host.current,
                await rpc.call("uiPreferences.read", null),
              );
            } catch {
              return;
            }
            await attempt(false);
          }
        };
        await attempt(true);
      });
    }
  }, [rpc]);

  const apply = useCallback(
    (next: SyncedPreferences) => {
      const merged = mergeSnapshot(host.current, next);
      host.current = merged;
      updateState((current) => {
        const agreed = mirrorOf(merged, current);
        mirror.current = agreed;
        return applyMirror(current, pendingMirror(agreed, pending.current));
      });
      flushPending();
    },
    [flushPending],
  );
  const read = useCallback(
    () =>
      rpc
        .call("uiPreferences.read", null)
        .then(apply)
        .catch(() => {
          // Offline or an older BB: local preferences keep working.
        }),
    [rpc, apply],
  );
  useEffect(() => {
    void read();
  }, [read, connection]);
  useEffect(() => {
    const onFocus = () => void read();
    const onVisible = () => {
      if (document.visibilityState === "visible") void read();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [read]);
  useRealtime(UI_PREFERENCES_CHANNEL, (payload) => {
    const parsed = syncedPreferenceEntrySchema.safeParse(payload);
    if (!parsed.success || !host.current) return;
    const entry = parsed.data;
    if (entry.revision <= host.current[entry.key].revision) return;
    apply({
      ...host.current,
      [entry.key]: { revision: entry.revision, value: entry.value },
    });
  });

  const projection = projectionOf(state);
  const projectionKey = JSON.stringify(projection);
  useEffect(() => {
    if (!host.current || !mirror.current) return;
    const next = projectionOf(stateRef.current);
    for (const key of changedKeys(mirror.current, next))
      pending.current.set(key, next);
    flushPending();
    // The projection key captures every field this effect compares.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectionKey, rpc, flushPending]);
}
