/**
 * Browser-side telemetry. The app installs one sender bound to the `clientLog`
 * RPC; the session layer, the error boundaries and the window handlers then
 * report through it, and every event lands in the plugin log on the server.
 * Events carry metadata only — paths, counts, phases — never file content.
 */
import { useEffect, useRef } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import manifest from "../package.json";
import { setSessionLogger, type SessionLogFields } from "./file-session";
import { CrashDeduper, isResizeObserverLoopMessage } from "./crash-dedup";

export const PLUGIN_VERSION = manifest.version;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, string | number | boolean | null>;

type ClientLogRpc = { call(method: "clientLog", input: { level: LogLevel; event: string; fields?: LogFields }): Promise<null> };

let sender: ClientLogRpc | null = null;
/** Serializes log calls so a burst cannot reorder events. */
let queue: Promise<unknown> = Promise.resolve();
let installedSenders = 0;

interface PendingEvent {
  level: LogLevel;
  event: string;
  fields: LogFields;
}

/**
 * Events that arrived before any surface bound a sender — a crash during a
 * surface's first render, for one — wait here for the next bind rather than
 * dropping. Bounded, so an unmounted page cannot grow it forever.
 */
const pendingEvents: PendingEvent[] = [];
const PENDING_EVENT_LIMIT = 100;

/** Bound while at least one editor surface is mounted. */
export function bindClientLog(rpc: ClientLogRpc): () => void {
  sender = rpc;
  installedSenders += 1;
  for (const held of pendingEvents.splice(0)) logClient(held.level, held.event, held.fields);
  setSessionLogger((event, fields) => {
    const clean: LogFields = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) clean[key] = value;
    }
    logClient("info", `session:${event}`, clean);
  });
  return () => {
    installedSenders -= 1;
    if (installedSenders === 0) {
      crashDeduper.flush();
      sender = null;
      setSessionLogger(null);
    }
  };
}

/** One event to the plugin log. Fire-and-forget; logging must never break the editor. */
export function logClient(level: LogLevel, event: string, fields: LogFields = {}): void {
  const full: LogFields = { version: PLUGIN_VERSION, ...fields };
  const rpc = sender;
  if (rpc === null) {
    pendingEvents.push({ level, event, fields: full });
    if (pendingEvents.length > PENDING_EVENT_LIMIT) pendingEvents.shift();
    return;
  }
  queue = queue.then(() =>
    rpc.call("clientLog", { level, event, fields: full }).catch(() => null),
  );
}

/** A stack's first frames, capped — enough to locate the throw, no content. */
export function sanitizeStack(stack: string | undefined): string | null {
  if (stack === undefined) return null;
  return stack.split("\n").slice(0, 8).join("\n").slice(0, 512);
}

export interface CrashContext {
  /** What the surface was doing, e.g. "editor", "markdown-preview". */
  phase: string;
  path?: string;
  extension?: string;
  bytes?: number;
  lines?: number;
  sourceKind?: string;
  host?: string;
}

function fieldsFor(context: CrashContext, extra: LogFields = {}): LogFields {
  const fields: LogFields = { phase: context.phase, ...extra };
  for (const key of ["path", "extension", "bytes", "lines", "sourceKind", "host"] as const) {
    const value = context[key];
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}

/**
 * Identical consecutive reports merge into one event tagged `occurrences`
 * (lib/crash-dedup.ts) so a ResizeObserver loop cannot flood the log.
 */
const crashDeduper = new CrashDeduper((level, fields) => logClient(level, "crash", fields));

/** componentDidCatch and Pierre surface failures report through here. */
export function reportCrash(context: CrashContext, error: unknown): void {
  const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  const level: LogLevel = isResizeObserverLoopMessage(message) ? "warn" : "error";
  const fields = fieldsFor(context, {
    message,
    stack: sanitizeStack(error instanceof Error ? error.stack : undefined),
  });
  crashDeduper.push(level, fields, [context.phase, context.path ?? "", message].join("\0"));
}

/**
 * Window-level errors while an editor surface is mounted. Scoped by lifetime:
 * the listeners exist only while a workbench holds them, so a quiet page does
 * not forward unrelated errors. Returns the unbind.
 */
export function installCrashReporting(context: () => CrashContext): () => void {
  const onError = (event: ErrorEvent) => {
    reportCrash({ ...context(), phase: `${context().phase}:window` }, event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    reportCrash({ ...context(), phase: `${context().phase}:unhandledrejection` }, event.reason);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

/**
 * Binds the log sender and the window handlers while an editor surface is on
 * screen. `context` is read per event, so it always describes the file open now.
 */
export function useEditorTelemetry(context: () => CrashContext): void {
  const rpc = useRpc<typeof rpcContract>();
  const latest = useRef(context);
  latest.current = context;
  useEffect(() => {
    const unbindLog = bindClientLog(rpc);
    const unbindCrash = installCrashReporting(() => latest.current());
    return () => {
      unbindCrash();
      unbindLog();
    };
  }, [rpc]);
}
