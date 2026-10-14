import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc, useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import type { projectsContract } from "./lib/contract";
import { appReads } from "./lib/dashboard-data";

/**
 * Shared by key across the app session; route changes synchronously select
 * their own data. A passive read only follows its key: another read keeps it
 * current (the panel read seeds its Initiative's summary overview).
 */
export function useData<T>(key: string, fetchData: (seed: (key: string, data: unknown) => void) => Promise<T>, enabled = true, passive = false) {
  const cache = appReads;
  const [, render] = useState(0);
  const refresh = useCallback(() => enabled ? cache.refresh(key, fetchData) : Promise.resolve(), [cache, key, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = cache.subscribe(key, () => render(n => n + 1));
    if (!passive) void refresh();
    return unsubscribe;
  }, [cache, key, enabled, passive, refresh]);
  const schedule = () => cache.schedule(key, fetchData);
  useRealtime("initiatives-changed", payload => {
    const id = (payload as { projectId?: string } | null)?.projectId;
    if (!enabled || passive || key === "inventory") return;
    const scoped = ["overview:", "details:", "compose:", "children:"].some(prefix => key.startsWith(prefix));
    const data = cache.entry(key).data as { projectId?: string; membership?: { projectId?: string } | null } | null;
    const membershipId = data?.projectId ?? data?.membership?.projectId;
    if (!id || scoped && key.endsWith(`:${id}`) || !scoped && (!membershipId || membershipId === id)) schedule();
  });
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const connectedOnce = useRef(connection === "connected");
  useEffect(() => {
    if (connection === "connected") {
      if (enabled && !passive && connectedOnce.current && previousConnection.current !== "connected") schedule();
      connectedOnce.current = true;
    }
    previousConnection.current = connection;
  }, [connection, cache, key, enabled]);
  useEffect(() => {
    if (!enabled || passive) return;
    const interval = setInterval(() => { if (document.visibilityState !== "hidden") schedule(); }, 15000);
    // A tab coming back or a network returning reads at once instead of on
    // the next poll, which a hidden tab skipped.
    const visible = () => { if (document.visibilityState !== "hidden") schedule(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", schedule);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", schedule);
    };
  }, [cache, key, enabled, passive]);
  const rpc = useRpc<typeof projectsContract>();
  useEffect(() => {
    cache.reporter = report => void rpc.call("reportReadTimeout", report).catch(() => {});
  }, [cache, rpc]);
  const entry = cache.entry(key);
  return { data: entry.data as T | null, error: entry.error, loaded: entry.loaded, refresh,
    schedule, begin: () => cache.begin(key) };
}
