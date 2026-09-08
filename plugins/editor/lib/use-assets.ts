import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";

export type AssetsState = { kind: "loading" } | { kind: "ready"; baseUrl: string } | { kind: "error"; message: string };

let shared: Promise<string> | null = null;

/**
 * Where the Pierre bundle is served from, asked once per page. The routes
 * never expire (see the server), so every caller can share one answer; a
 * failed ask is dropped so the next mount, or a bumped `attempt`, tries again.
 */
export function useAssets(attempt = 0): AssetsState {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<AssetsState>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    shared ??= rpc.call("assets", null).then((result) => result.baseUrl).catch((error: unknown) => {
      shared = null;
      throw error;
    });
    shared
      .then((baseUrl) => {
        if (!cancelled) setState({ kind: "ready", baseUrl });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : "Could not reach the editor assets" });
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, attempt]);
  return state;
}
