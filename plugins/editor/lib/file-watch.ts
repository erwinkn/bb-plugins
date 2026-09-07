/**
 * Change notices for the files of a source. The server watches the source's
 * root on its host and publishes one signal per batch; this hook turns a
 * signal into re-reads of the open files it names, and tells the caller so
 * the tree or the change list can follow.
 *
 * A page has one client id, so two panels on the same source share one
 * registration. The registration is renewed at half its lifetime and
 * released when the last panel leaves. Without a watch, the poll in
 * `file-session.ts` carries on alone.
 */
import { useEffect, useRef } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { refreshFiles, refreshOpenFiles, setSourceWatched, sourceKeyFor, type FileSessionSource } from "./file-session";
import { FILES_CHANGED_CHANNEL, filesChangedSchema, type FilesChangedSignal } from "./watch-contract";

export type FileChange = FilesChangedSignal["changes"][number];

export interface FileWatchEvent {
  kind: "changed" | "rescan";
  changes: readonly FileChange[];
}

type Listener = (event: FileWatchEvent) => void;

interface Registration {
  source: FileSessionSource;
  root: string | null;
  panels: number;
  timer: ReturnType<typeof setTimeout> | null;
  listeners: Set<Listener>;
}

const CLIENT_ID = globalThis.crypto.randomUUID();
const registrations = new Map<string, Registration>();
let lastSeq = 0;

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

async function renew(rpc: Rpc, registration: Registration): Promise<void> {
  if (registration.timer !== null) clearTimeout(registration.timer);
  registration.timer = null;
  try {
    const result = await rpc.call("watch", { source: registration.source, clientId: CLIENT_ID });
    if (registrations.get(sourceKeyFor(registration.source)) !== registration) return;
    registration.root = result.root;
    setSourceWatched(registration.source, result.root !== null);
    // A root that cannot be watched is asked about again later: its host may
    // come back, or a newer daemon may take over.
    registration.timer = setTimeout(() => void renew(rpc, registration), result.ttlMs / 2);
  } catch {
    if (registrations.get(sourceKeyFor(registration.source)) !== registration) return;
    registration.root = null;
    setSourceWatched(registration.source, false);
    registration.timer = setTimeout(() => void renew(rpc, registration), 60_000);
  }
}

function release(rpc: Rpc, key: string, registration: Registration): void {
  if (registration.timer !== null) clearTimeout(registration.timer);
  registration.timer = null;
  registrations.delete(key);
  setSourceWatched(registration.source, false);
  void rpc.call("unwatch", { source: registration.source, clientId: CLIENT_ID }).catch(() => undefined);
}

/** Acts on one signal for the whole page, whichever panel's subscription saw it first. */
function deliver(payload: unknown): void {
  const parsed = filesChangedSchema.safeParse(payload);
  if (!parsed.success || parsed.data.seq <= lastSeq) return;
  lastSeq = parsed.data.seq;
  const signal = parsed.data;
  for (const registration of registrations.values()) {
    if (registration.root !== signal.root) continue;
    if (signal.kind === "rescan") refreshOpenFiles({ force: true });
    else refreshFiles(registration.source, signal.changes.map((change) => change.path));
    for (const listener of registration.listeners) listener({ kind: signal.kind, changes: signal.changes });
  }
}

/** After a lost connection, nothing that happened meanwhile was delivered. */
function rescanAll(): void {
  refreshOpenFiles({ force: true });
  for (const registration of registrations.values()) {
    for (const listener of registration.listeners) listener({ kind: "rescan", changes: [] });
  }
}

/**
 * Keep the files of `source` current while the caller is mounted.
 * `onChange` runs after the open files were told, with the batch that came
 * in; a `rescan` batch has no paths and means everything may have changed.
 */
export function useFileWatch(source: FileSessionSource | null, onChange?: (event: FileWatchEvent) => void): void {
  const rpc = useRpc<typeof rpcContract>();
  const latest = useRef(onChange);
  latest.current = onChange;
  const key = source === null ? null : sourceKeyFor(source);

  useEffect(() => {
    if (source === null || key === null) return;
    const listener: Listener = (event) => latest.current?.(event);
    let registration = registrations.get(key);
    if (registration === undefined) {
      registration = { source, root: null, panels: 0, timer: null, listeners: new Set() };
      registrations.set(key, registration);
      void renew(rpc, registration);
    }
    registration.panels += 1;
    registration.listeners.add(listener);
    return () => {
      const current = registrations.get(key);
      if (current === undefined) return;
      current.listeners.delete(listener);
      current.panels -= 1;
      if (current.panels === 0) release(rpc, key, current);
    };
    // The source object is new on every render; its key says whether it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, key]);

  useRealtime(FILES_CHANGED_CHANNEL, deliver);

  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current === "reconnecting" && connection === "connected") rescanAll();
    previous.current = connection;
  }, [connection]);
}
