// Voice page: logical voice sessions inside bb. The home lists sessions (one
// per logical conversation, spanning every physical call that continued it).
// Selecting one shows the Conversation by default — your words and one
// assistant identity — with a session-scoped Coordinator debug view and a
// Diagnostics tab over the raw event log. A bottom-center call console starts
// or controls the call right here, so you never route through the composer
// (which collapses on mobile) or switch sidebars to talk.
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "./components/ui/button";
import {
  experimental_useSidebarThreadActions,
  useBbContext,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { voiceAgent } from "./voice-agent";
import { LiveCallControls, MicIcon, WaveformIcon } from "./voice-chrome";
import { viewWorkspace } from "./view-workspace";
import { actionStatus, pairToolEvents } from "./session-events";
import { CompanionTab } from "./companion";
import { CoordinatorCard } from "./coordinator-panel";
import { activeConversationId, resolveSession, sessionApi, startConversation, type VoiceSessionRow } from "./session-api";
import { describeDelivery, projectConversation, type ConversationMessage } from "./session-projection";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface EventRow {
  id: number;
  ts: number;
  kind: string;
  payload: string;
  /** Physical call the event was logged in; a logical session can span several. */
  callId?: string;
}
interface PluginMeta {
  id: string;
  name: string;
  iconUrl: string | null;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function duration(startMs: number, endMs: number): string {
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Open this plugin's settings page (Settings → Plugins → Voice Mode). The SDK
 * only hands `openSettings()` to sidebar footer actions, so from a nav panel we
 * push the host route directly and nudge the router with a popstate event.
 */
function openVoiceModeSettings() {
  window.history.pushState({}, "", "/settings/plugins/voice-mode");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** The exact gear bb uses for its own Settings button (hugeicons Settings01). */
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21.3175 7.14139L20.8239 6.28479C20.4506 5.63696 20.264 5.31305 19.9464 5.18388C19.6288 5.05472 19.2696 5.15664 18.5513 5.36048L17.3311 5.70418C16.8725 5.80994 16.3913 5.74994 15.9726 5.53479L15.6357 5.34042C15.2766 5.11043 15.0004 4.77133 14.8475 4.37274L14.5136 3.37536C14.294 2.71534 14.1842 2.38533 13.9228 2.19657C13.6615 2.00781 13.3143 2.00781 12.6199 2.00781H11.5051C10.8108 2.00781 10.4636 2.00781 10.2022 2.19657C9.94085 2.38533 9.83106 2.71534 9.61149 3.37536L9.27753 4.37274C9.12465 4.77133 8.84845 5.11043 8.48937 5.34042L8.15249 5.53479C7.73374 5.74994 7.25259 5.80994 6.79398 5.70418L5.57375 5.36048C4.85541 5.15664 4.49625 5.05472 4.17867 5.18388C3.86109 5.31305 3.67445 5.63696 3.30115 6.28479L2.80757 7.14139C2.45766 7.74864 2.2827 8.05227 2.31666 8.37549C2.35061 8.69871 2.58483 8.95918 3.05326 9.48012L4.0843 10.6328C4.3363 10.9518 4.51521 11.5078 4.51521 12.0077C4.51521 12.5078 4.33636 13.0636 4.08433 13.3827L3.05326 14.5354C2.58483 15.0564 2.35062 15.3168 2.31666 15.6401C2.2827 15.9633 2.45766 16.2669 2.80757 16.8741L3.30114 17.7307C3.67443 18.3785 3.86109 18.7025 4.17867 18.8316C4.49625 18.9608 4.85542 18.8589 5.57377 18.655L6.79394 18.3113C7.25263 18.2055 7.73387 18.2656 8.15267 18.4808L8.4895 18.6752C8.84851 18.9052 9.12464 19.2442 9.2775 19.6428L9.61149 20.6403C9.83106 21.3003 9.94085 21.6303 10.2022 21.8191C10.4636 22.0078 10.8108 22.0078 11.5051 22.0078H12.6199C13.3143 22.0078 13.6615 22.0078 13.9228 21.8191C14.1842 21.6303 14.294 21.3003 14.5136 20.6403L14.8476 19.6428C15.0004 19.2442 15.2765 18.9052 15.6356 18.6752L15.9724 18.4808C16.3912 18.2656 16.8724 18.2055 17.3311 18.3113L18.5513 18.655C19.2696 18.8589 19.6288 18.9608 19.9464 18.8316C20.264 18.7025 20.4506 18.3785 20.8239 17.7307L21.3175 16.8741C21.6674 16.2669 21.8423 15.9633 21.8084 15.6401C21.7744 15.3168 21.5402 15.0564 21.0718 14.5354L20.0407 13.3827C19.7887 13.0636 19.6098 12.5078 19.6098 12.0077C19.6098 11.5078 19.7888 10.9518 20.0407 10.6328L21.0718 9.48012C21.5402 8.95918 21.7744 8.69871 21.8084 8.37549C21.8423 8.05227 21.6674 7.74864 21.3175 7.14139Z" />
      <path d="M15.5195 12C15.5195 13.933 13.9525 15.5 12.0195 15.5C10.0865 15.5 8.51953 13.933 8.51953 12C8.51953 10.067 10.0865 8.5 12.0195 8.5C13.9525 8.5 15.5195 10.067 15.5195 12Z" />
    </svg>
  );
}

/**
 * The call console — a bottom-center control that owns the entire call
 * lifecycle right on the Voice page. Idle: a "Talk to Aide" pill. Live: it
 * expands into a console (mute · who-has-the-floor + duration · jump to the live
 * transcript · stop). Same neutral-chrome + activity-color language as the
 * composer pill; color marks who's speaking, everything else stays neutral.
 *
 * Rendered as a real element in a footer bar (not `position: fixed`) so it
 * reserves its own space — nothing overlaps — and stays inside the plugin's own
 * pointer/stacking context, which is what makes it reliably tappable on mobile.
 */
function CallConsole({ onViewTranscript, viewingLive }: { onViewTranscript: (callId: string) => void; viewingLive: boolean }) {
  const state = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  const lastActivity = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getLastActivity);
  if (state === "idle") return null;

  const liveId = voiceAgent.getSessionId();
  const ticker = tickerFor(lastActivity);
  // When you're already reading the live session, the ticker (and the pill's
  // transcript button) are redundant with what's on screen — hide them.

  return (
    <div className="flex w-full flex-col items-center gap-1.5">
      {liveId && !viewingLive ? (
        <button
          type="button"
          onClick={() => onViewTranscript(liveId)}
          className="flex min-h-11 max-w-full items-center gap-1.5 rounded-md px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:min-h-8"
          title="See full transcript"
        >
          {ticker?.family ? (
            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/80">
              <ActionGlyph family={ticker.family} />
            </span>
          ) : null}
          <span className="truncate">{ticker?.text ?? "See full transcript"}</span>
          <svg viewBox="0 0 16 16" className="size-3 shrink-0 text-muted-foreground/50" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 4l4 4-4 4" />
          </svg>
        </button>
      ) : null}
      <LiveCallControls />
    </div>
  );
}

// ─── Transcript rendering ────────────────────────────────────────────────────
// The transcript reads as a narrative, not a raw log: speech is attributed with
// a speaker gutter + tint, and tool calls become human "action chips" (a paired
// call+result resolved into one line) with the raw {args, output} always one
// tap away. The action set is open-ended (built-ins + a dynamic
// run_plugin_command), so known tools get crafted phrasing and everything else
// falls through a generic humanizer — nothing is ever dropped or shown as junk.

type ActionFamily = "inspect" | "navigate" | "mutate" | "compose" | "self" | "plugin" | "other";

const ACTIONS: Record<string, { family: ActionFamily; verb: string }> = {
  get_context: { family: "inspect", verb: "Read your context" },
  list_projects: { family: "inspect", verb: "Listed projects" },
  list_machines: { family: "inspect", verb: "Listed machines" },
  list_live_threads: { family: "inspect", verb: "Listed live threads" },
  list_threads: { family: "inspect", verb: "Listed threads" },
  search_threads: { family: "inspect", verb: "Searched threads" },
  read_thread: { family: "inspect", verb: "Read a thread" },
  focus_thread: { family: "navigate", verb: "Showed a thread" },
  focus_threads: { family: "navigate", verb: "Showed threads" },
  manage_views: { family: "navigate", verb: "Updated views" },
  set_view_behavior: { family: "self", verb: "Changed thread-opening preference" },
  set_pane: { family: "navigate", verb: "Changed the layout" },
  show_diff: { family: "navigate", verb: "Opened a diff" },
  send_to_thread: { family: "mutate", verb: "Sent a message" },
  start_thread: { family: "mutate", verb: "Started a thread" },
  stop_thread: { family: "mutate", verb: "Stopped a thread" },
  archive_thread: { family: "mutate", verb: "Archived a thread" },
  rename_thread: { family: "mutate", verb: "Renamed a thread" },
  update_instructions: { family: "self", verb: "Updated its instructions" },
  set_composer_text: { family: "compose", verb: "Drafted a message" },
  append_composer_text: { family: "compose", verb: "Appended to the draft" },
  run_plugin_command: { family: "plugin", verb: "Ran a plugin command" },
  delegate_to_coordinator: { family: "mutate", verb: "Handed off to the coordinator" },
  remain_silent: { family: "self", verb: "Stayed silent" },
  end_call: { family: "self", verb: "Ended the call" },
};

function actionMeta(name: string): { family: ActionFamily; verb: string } {
  return ACTIONS[name] ?? { family: "other", verb: name.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase()) };
}

/**
 * Human label for the dock's activity ticker from the agent's last event: a
 * tool call shows its verb (with the family glyph); speech/notice show a short
 * quote (no glyph). Returns null when there's nothing worth showing yet.
 */
function tickerFor(last: { kind: string; name: string; text: string } | null): { family: ActionFamily | null; text: string } | null {
  if (!last) return null;
  if (last.kind === "tool.call") {
    const meta = actionMeta(last.name);
    return { family: meta.family, text: meta.verb };
  }
  const text = last.text.trim();
  if (!text) return null;
  const clipped = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return { family: null, text: last.kind === "assistant" ? `“${clipped}”` : clipped };
}

/** The most salient argument to show inline next to the verb, if any. */
function actionObject(name: string, args: Record<string, unknown>): string {
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const clip = (text: string, max = 64): string => (text.length > max ? `${text.slice(0, max)}…` : text);
  if (name === "run_plugin_command") {
    const argv = Array.isArray(args.argv) ? (args.argv as unknown[]).map(String).join(" ") : "";
    return clip([str(args.plugin_id), argv].filter(Boolean).join(" "));
  }
  return clip(str(args.query) || str(args.title) || str(args.message) || str(args.text) || str(args.prompt) || str(args.action));
}

function ActionGlyph({ family }: { family: ActionFamily }) {
  const cls = "size-3";
  switch (family) {
    case "inspect":
      return <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><circle cx="7" cy="7" r="4" /><path d="M13 13l-3-3" /></svg>;
    case "navigate":
      return <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" /></svg>;
    case "mutate":
      return <svg viewBox="0 0 16 16" className={cls} fill="currentColor" aria-hidden><path d="M8.7 1L3 9h4l-1.3 6L13 6.5H8.6z" /></svg>;
    case "compose":
      return <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M11 2.4l2.6 2.6L6 12.6l-3.2.6.6-3.2z" /></svg>;
    case "self":
      return <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden><circle cx="8" cy="8" r="2.1" /><circle cx="8" cy="8" r="5.5" /></svg>;
    case "plugin":
      return <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden><path d="M6.2 2.5h3.6v1.6a1.4 1.4 0 002.8 0V4h1.4v3.4h-1.6a1.4 1.4 0 000 2.8h1.6V13H2.4V9.9H4a1.4 1.4 0 000-2.8H2.4V2.5z" /></svg>;
    default:
      return <svg viewBox="0 0 16 16" className={cls} fill="currentColor" aria-hidden><circle cx="8" cy="8" r="2.4" /></svg>;
  }
}

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" className="ml-auto size-3 shrink-0 text-muted-foreground/40 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

type Row =
  | { kind: "callmark"; id: number; ts: number; callId: string; index: number }
  | { kind: "speech"; id: number; ts: number; who: "you" | "aide"; text: string }
  | { kind: "action"; id: number; ts: number; name: string; args: Record<string, unknown>; output: string | null; status?: "success" | "error"; label?: string }
  | { kind: "notice"; id: number; ts: number; text: string }
  | { kind: "error"; id: number; ts: number; message: string }
  | { kind: "sysgroup"; id: number; ts: number; events: EventRow[] };

const CONVERSATION_KINDS = new Set(["user", "assistant", "tool.call", "tool.result", "notice", "error", "reply.speaking"]);

/**
 * Fold the raw event log into display rows: pair each tool.call with its result,
 * and coalesce runs of low-level diagnostics (session.*, conn.*, audio.*) into a
 * single collapsible "session connected"-style group so they don't bury the
 * conversation. The full detail stays one tap away inside the group.
 */
function buildRows(events: EventRow[]): Row[] {
  const rows: Row[] = [];
  const pairs = pairToolEvents(events);
  const pairedResults = new Set([...pairs.values()].map(result => result.id));
  let diagnostics: EventRow[] = [];
  const flush = () => {
    if (diagnostics.length === 0) return;
    rows.push({ kind: "sysgroup", id: diagnostics[0].id, ts: diagnostics[0].ts, events: diagnostics });
    diagnostics = [];
  };
  // A logical session spans physical calls; mark where each one begins.
  const callIds = [...new Set(events.map((event) => event.callId).filter((id): id is string => !!id))];
  let currentCall: string | null = null;
  events.forEach((event) => {
    if (event.callId && event.callId !== currentCall && callIds.length > 1) {
      flush();
      currentCall = event.callId;
      rows.push({ kind: "callmark", id: -event.id, ts: event.ts, callId: event.callId, index: callIds.indexOf(event.callId) + 1 });
    }
    if (!CONVERSATION_KINDS.has(event.kind)) {
      diagnostics.push(event);
      return;
    }
    flush();
    const payload = parsePayload(event.payload);
    switch (event.kind) {
      case "user":
      case "assistant":
        rows.push({ kind: "speech", id: event.id, ts: event.ts, who: event.kind === "user" ? "you" : "aide", text: String(payload.text ?? "") });
        break;
      case "tool.call": {
        const name = String(payload.name ?? "?");
        const result = pairs.get(event.id)?.payload;
        const output = result ? String(result.output ?? "") : null;
        const status = result ? actionStatus(result) : undefined;
        const label = typeof result?.label === "string" ? result.label : undefined;
        rows.push({ kind: "action", id: event.id, ts: event.ts, name, args: (payload.args as Record<string, unknown>) ?? {}, output, status, label });
        break;
      }
      case "tool.result":
        if (pairedResults.has(event.id)) break; // already merged into its call
        rows.push({ kind: "action", id: event.id, ts: event.ts, name: String(payload.name ?? "?"), args: {}, output: String(payload.output ?? ""), status: actionStatus(payload), label: typeof payload.label === "string" ? payload.label : undefined });
        break;
      case "notice":
        rows.push({ kind: "notice", id: event.id, ts: event.ts, text: String(payload.text ?? "") });
        break;
      case "reply.speaking":
        // A coordinator reply the bridge started speaking (delivery is logged separately).
        rows.push({ kind: "notice", id: event.id, ts: event.ts, text: `Coordinator (${String(payload.kind ?? "reply")}): ${String(payload.text ?? "")}` });
        break;
      case "error":
        rows.push({ kind: "error", id: event.id, ts: event.ts, message: String(payload.message ?? "error") });
        break;
    }
  });
  flush();
  return rows;
}

/** Human label for a diagnostics group, from the lifecycle events it contains. */
function sysGroupLabel(events: EventRow[]): string {
  const kinds = new Set(events.map((event) => event.kind));
  if (kinds.has("session.stopped")) return "Session ended";
  if (kinds.has("session.live")) return "Session connected";
  if (kinds.has("session.started")) return "Session connecting";
  return "Session activity";
}

function SpeechRow({ row }: { row: Extract<Row, { kind: "speech" }> }) {
  const you = row.who === "you";
  return (
    <div className={cn("flex gap-3 rounded-md px-3 py-3", you ? "bg-muted/40" : "bg-transparent")}>
      <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full", you ? "bg-muted text-muted-foreground" : "bg-primary/15 text-primary")}>
        <span className="scale-75">{you ? <MicIcon slashed={false} /> : <WaveformIcon live={false} />}</span>
      </span>
      <div className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("text-xs font-semibold", you ? "text-foreground" : "text-primary")}>{you ? "You" : "Aide"}</span>
          <span className="text-xs tabular-nums text-muted-foreground">{fmtTime(row.ts)}</span>
        </span>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{row.text}</p>
      </div>
    </div>
  );
}

function ActionRow({ row, plugins }: { row: Extract<Row, { kind: "action" }>; plugins: Map<string, PluginMeta> }) {
  const meta = actionMeta(row.name);
  const pending = row.output === null;
  const isError = !pending && row.status === "error";
  const hasArgs = Object.keys(row.args).length > 0;

  // run_plugin_command reads as "Used plugin [chip]": the left square keeps the
  // generic plugin glyph (consistent with every action row), and the plugin's
  // real name + icon (from listPlugins) ride in a chip next to it.
  const isPlugin = row.name === "run_plugin_command";
  let verb = pending ? "Working…" : isError ? "Couldn’t complete action" : row.label ?? meta.verb;
  let object = row.label ? "" : actionObject(row.name, row.args);
  let pluginName = "";
  let pluginIcon: string | null = null;
  if (isPlugin) {
    const pluginId = typeof row.args.plugin_id === "string" ? row.args.plugin_id : "";
    const plugin = plugins.get(pluginId);
    verb = "Used plugin";
    pluginName = plugin?.name ?? pluginId;
    pluginIcon = plugin?.iconUrl ?? null;
    object = Array.isArray(row.args.argv) ? (row.args.argv as unknown[]).map(String).join(" ") : "";
  }

  return (
    <details className="group min-w-0 pl-2.5">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 py-1 text-xs">
        <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-md", isError ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground")}>
          <ActionGlyph family={meta.family} />
        </span>
        <span className={cn("shrink-0 font-medium", isError ? "text-destructive" : "text-foreground/80")}>{verb}</span>
        {isPlugin && pluginName ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-px text-[11px] font-medium text-foreground/80">
            {pluginIcon ? <img src={pluginIcon} alt="" className="size-3 rounded-[3px] object-contain" /> : null}
            {pluginName}
          </span>
        ) : null}
        {object ? <span className="min-w-0 truncate text-muted-foreground">· {object}</span> : null}
        {pending ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" /> : null}
        <Chevron />
      </summary>
      <div className="mb-1 mt-1 space-y-1 pl-7">
        {hasArgs ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px] text-muted-foreground">{JSON.stringify(row.args, null, 2)}</pre>
        ) : null}
        {row.output ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px] text-foreground/80">{row.output}</pre>
        ) : (
          <p className="text-[11px] italic text-muted-foreground">Waiting for result…</p>
        )}
      </div>
    </details>
  );
}

function NoticeRow({ row }: { row: Extract<Row, { kind: "notice" }> }) {
  return (
    <p className="px-2 py-1 text-center text-xs italic text-muted-foreground/80">🔔 {row.text}</p>
  );
}

function ErrorRow({ row }: { row: Extract<Row, { kind: "error" }> }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5">
      <span className="mt-px text-xs text-destructive">⚠</span>
      <span className="text-sm text-destructive">{row.message}</span>
    </div>
  );
}

function SysGroupRow({ row }: { row: Extract<Row, { kind: "sysgroup" }> }) {
  const label = sysGroupLabel(row.events);
  return (
    <details className="group min-w-0">
      <summary className="mx-auto flex min-h-11 w-fit cursor-pointer list-none items-center justify-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:min-h-8">
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        {label}
        <span className="text-muted-foreground/40">· {row.events.length}</span>
        <Chevron />
      </summary>
      <div className="mt-1 space-y-1 rounded-md bg-muted/40 p-2">
        {row.events.map((event) => {
          const payload = event.payload && event.payload !== "{}" ? event.payload : "";
          return (
            <div key={event.id} className="min-w-0 font-mono text-[10px] leading-relaxed text-muted-foreground">
              <span className="mr-2 tabular-nums text-muted-foreground/50">{fmtTime(event.ts)}</span>
              <span className="text-foreground/70">{event.kind}</span>
              {payload ? <span className="break-all"> {payload}</span> : null}
            </div>
          );
        })}
      </div>
    </details>
  );
}

type TranscriptFilter = "all" | "talk" | "actions" | "errors";

const FILTERS: { id: TranscriptFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "talk", label: "Conversation" },
  { id: "actions", label: "Actions" },
  { id: "errors", label: "Errors" },
];

function rowMatchesFilter(row: Row, filter: TranscriptFilter): boolean {
  const actionErrored = row.kind === "action" && row.status === "error";
  switch (filter) {
    case "talk":
      return row.kind === "speech" || row.kind === "notice" || row.kind === "callmark";
    case "actions":
      return row.kind === "action" || row.kind === "callmark";
    case "errors":
      return row.kind === "error" || actionErrored || row.kind === "callmark";
    default:
      return true;
  }
}

function FilterBar({ value, onChange }: { value: TranscriptFilter; onChange: (next: TranscriptFilter) => void }) {
  return (
    <div role="group" aria-label="Transcript filters" className="flex max-w-full flex-wrap items-center gap-1 sm:rounded-md sm:border sm:border-border sm:p-1">
      {FILTERS.map((filter) => (
        <Button
          key={filter.id}
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={value === filter.id}
          onClick={() => onChange(filter.id)}
          className={cn(
            "min-h-11 px-2 sm:min-h-8",
            value === filter.id ? "bg-accent text-foreground" : "text-muted-foreground",
          )}
        >
          {filter.label}
        </Button>
      ))}
    </div>
  );
}

function TranscriptBody({ events, plugins, filter }: { events: EventRow[]; plugins: Map<string, PluginMeta>; filter: TranscriptFilter }) {
  const rows = buildRows(events).filter((row) => rowMatchesFilter(row, filter));
  if (rows.length === 0) {
    return <p className="py-3 text-center text-sm text-muted-foreground">Nothing matches this filter.</p>;
  }
  return (
    <div className="space-y-1 py-1.5">
      {rows.map((row) => {
        switch (row.kind) {
          case "speech":
            return <SpeechRow key={row.id} row={row} />;
          case "action":
            return <ActionRow key={row.id} row={row} plugins={plugins} />;
          case "notice":
            return <NoticeRow key={row.id} row={row} />;
          case "error":
            return <ErrorRow key={row.id} row={row} />;
          case "callmark":
            return (
              <div key={row.id} role="separator" aria-label={`Call ${row.index}`} className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>Call {row.index} · {fmtDate(row.ts)}</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            );
          default:
            return <SysGroupRow key={row.id} row={row} />;
        }
      })}
    </div>
  );
}

/**
 * Close the page on Escape by going back in history (bb's router follows
 * popstate). Skips presses aimed at inputs/textareas/contenteditables and
 * ones something else already handled (e.g. closing a dialog), so Escape
 * still means "dismiss" inside nested UI.
 */
function useEscapeToClose(onBack?: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement)
      ) {
        return;
      }
      event.preventDefault();
      if (onBack) onBack();
      else window.history.back();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack, active]);
}

export function SessionsPanel() {
  const [inspecting, setInspecting] = useState(false);
  const views = useSyncExternalStore(viewWorkspace.subscribe, viewWorkspace.get);
  const root = useRef<HTMLDivElement>(null);
  const showThreads = inspecting && views.views.length > 0;
  useEffect(() => viewWorkspace.registerPresenter({
    available: () => document.visibilityState !== "hidden" && !!root.current,
    reveal: () => { setInspecting(true); return true; },
  }), []);
  return (
    <div ref={root} className="flex h-full min-h-0 flex-col">
      {views.views.length > 0 ? (
        <div role="group" aria-label="Voice area" className="flex shrink-0 gap-2 border-b border-border p-2">
          <Button variant={showThreads ? "ghost" : "secondary"} aria-pressed={!showThreads} onClick={() => setInspecting(false)}>Session</Button>
          <Button variant={showThreads ? "secondary" : "ghost"} aria-pressed={showThreads} onClick={() => setInspecting(true)}>Threads ({views.views.length})</Button>
        </div>
      ) : null}
      <div hidden={showThreads} className={showThreads ? "hidden" : "min-h-0 flex-1"}>
        <SessionHistoryPanel active={!showThreads} />
      </div>
      {showThreads ? <div className="min-h-0 flex-1"><CompanionTab /></div> : null}
    </div>
  );
}

type SessionTab = "conversation" | "coordinator" | "diagnostics";

const SESSION_TABS: { id: SessionTab; label: string }[] = [
  { id: "conversation", label: "Conversation" },
  { id: "coordinator", label: "Coordinator" },
  { id: "diagnostics", label: "Diagnostics" },
];

function KindChip({ kind }: { kind: ConversationMessage["kind"] }) {
  const label = kind === "question" ? "Question" : kind === "update" ? "Update" : kind === "failure" ? "Problem" : kind === "progress" ? "Progress" : null;
  if (!label) return null;
  return <span className={cn("rounded-full border px-1.5 py-px text-[10px] font-medium", kind === "failure" ? "border-destructive/40 text-destructive" : "border-border text-muted-foreground")}>{label}</span>;
}

/** One message of the unified conversation: you, or the one assistant identity. */
function MessageRow({ message }: { message: ConversationMessage }) {
  const you = message.who === "you";
  const delivery = describeDelivery(message.delivery);
  return (
    <div className={cn("flex gap-3 rounded-md px-3 py-3", you ? "bg-muted/40" : "bg-transparent")} data-message-id={message.id}>
      <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full", you ? "bg-muted text-muted-foreground" : "bg-primary/15 text-primary")}>
        <span className="scale-75">{you ? <MicIcon slashed={false} /> : <WaveformIcon live={false} />}</span>
      </span>
      <div className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className={cn("text-xs font-semibold", you ? "text-foreground" : "text-primary")}>{you ? "You" : "Aide"}</span>
          <span className="text-xs tabular-nums text-muted-foreground">{fmtTime(message.ts)}</span>
          <KindChip kind={message.kind} />
          {delivery ? <span className={cn("text-[10px]", message.delivery === "interrupted" ? "text-destructive" : "text-muted-foreground")} title={message.attributedByWindow ? "Playback state inferred from the reply that was being spoken" : undefined}>{delivery}</span> : null}
        </span>
        <p className={cn("whitespace-pre-wrap break-words text-sm leading-relaxed", message.delivery === "unplayed" ? "text-muted-foreground line-through decoration-muted-foreground/40" : "text-foreground")}>{message.text}</p>
      </div>
    </div>
  );
}

function ConversationView({ events, live }: { events: EventRow[]; live: boolean }) {
  const messages = projectConversation(events);
  if (messages.length === 0) {
    return <p className="py-4 text-center text-sm text-muted-foreground">{live ? "Your conversation will appear here as you speak." : "No conversation was recorded for this session."}</p>;
  }
  return (
    <div aria-label="Conversation" className="space-y-1 py-1.5">
      {messages.map((message) => <MessageRow key={message.id} message={message} />)}
    </div>
  );
}

function SessionHistoryPanel({ active }: { active: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const api = sessionApi(rpc);
  const { threadId, projectId } = useBbContext();
  const sidebarActions = experimental_useSidebarThreadActions();

  // The Voice page has no composer, so nothing else binds the voice agent
  // here. Install a fallback binding so the call console can actually start a
  // call from a cold page — but only when nothing richer is already bound (a
  // live composer's binding, which its text tools target, must win). We
  // deliberately bind no composer: with nothing to type into, the text tools
  // report that honestly rather than silently opening a thread behind the
  // user's back. Everything else runs through rpc, which works from anywhere.
  useEffect(() => {
    return voiceAgent.bindFallback({
      rpc,
      context: { threadId: threadId ?? null, projectId: projectId ?? null, onNewThreadScreen: false },
      openNewThread: (targetProjectId) =>
        sidebarActions.openNewThread({
          ...(targetProjectId ? { projectId: targetProjectId } : {}),
          focusPrompt: true,
        }),
    });
  }, [rpc, threadId, projectId, sidebarActions]);

  const [sessions, setSessions] = useState<VoiceSessionRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** A logical session id, or an older physical call id (still resolvable). */
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<SessionTab>("conversation");
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const historyHeadingRef = useRef<HTMLHeadingElement>(null);
  const sessionButtons = useRef(new Map<string, HTMLButtonElement>());
  const previousSelection = useRef<string | null>(null);
  useEffect(() => {
    if (selected) {
      previousSelection.current = selected;
      backButtonRef.current?.focus({ preventScroll: true });
    } else if (previousSelection.current) {
      (sessionButtons.current.get(previousSelection.current) ?? historyHeadingRef.current)?.focus();
      previousSelection.current = null;
    }
  }, [selected]);
  const backToSessions = useCallback(() => setSelected(null), []);
  useEscapeToClose(selected ? backToSessions : undefined, active);
  const [detail, setDetail] = useState<{ session: VoiceSessionRow; events: EventRow[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const callState = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getState);
  const activeCallId = useSyncExternalStore(voiceAgent.subscribe, voiceAgent.getSessionId);
  const activeSession = useSyncExternalStore(voiceAgent.subscribe, activeConversationId);
  const [filter, setFilter] = useState<TranscriptFilter>("all");
  const [search, setSearch] = useState("");
  const [plugins, setPlugins] = useState<Map<string, PluginMeta>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingBottom = useRef(false);
  /** Set by New session / Continue so the session that starts is selected once known. */
  const startRequested = useRef(false);

  const mergeNewest = useCallback((rows: VoiceSessionRow[], more: boolean) => {
    setSessions((prev) => {
      if (!prev) {
        setHasMore(more);
        return rows;
      }
      const incoming = new Map(rows.map((row) => [row.id, row]));
      const updated = prev.map((session) => incoming.get(session.id) ?? session);
      const existing = new Set(prev.map((session) => session.id));
      const fresh = rows.filter((row) => !existing.has(row.id));
      const merged = fresh.length ? [...fresh, ...updated] : updated;
      return merged.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
    });
  }, []);

  const refreshNewest = useCallback(() => {
    api.list(null).then(
      (result) => {
        mergeNewest(result.sessions, result.hasMore);
        setError(null);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
    // `api` is derived from the stable rpc client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, mergeNewest]);

  const loadMore = useCallback(() => {
    if (!sessions?.length || loadingMore) return;
    setLoadingMore(true);
    const last = sessions[sessions.length - 1];
    api.list({ updatedAt: last.updatedAt, id: last.id }).then(
      (result) => {
        setSessions((prev) => {
          if (!prev) return result.sessions;
          const existing = new Set(prev.map((session) => session.id));
          return [...prev, ...result.sessions.filter((row) => !existing.has(row.id))];
        });
        setHasMore(result.hasMore);
        setLoadingMore(false);
      },
      (cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoadingMore(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, sessions, loadingMore]);

  const refetchDetail = useCallback(
    (sessionId: string, showLoading = false) => {
      const request = ++detailRequest.current;
      if (showLoading) setDetailLoading(true);
      setDetailError(null);
      api.get(sessionId).then(
        (result) => {
          if (request !== detailRequest.current) return;
          setDetail(result);
          setDetailLoading(false);
        },
        (cause) => {
          if (request !== detailRequest.current) return;
          setDetailError(cause instanceof Error ? cause.message : String(cause));
          setDetailLoading(false);
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rpc],
  );

  useEffect(() => {
    refreshNewest();
  }, [refreshNewest]);
  useEffect(() => {
    rpc.call("listPlugins", null).then(
      (result) => setPlugins(new Map(result.plugins.map((plugin) => [plugin.id, plugin]))),
      () => undefined,
    );
  }, [rpc]);
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    setTab("conversation");
    if (selected) {
      pendingBottom.current = true;
      refetchDetail(selected, true);
    }
    return () => { detailRequest.current += 1; };
  }, [selected, refetchDetail]);

  // A call started from this page: select its session as soon as it is known.
  useEffect(() => {
    if ((!startRequested.current && selected !== null) || !activeSession || callState === "idle" || callState === "connecting") return;
    startRequested.current = false;
    setSelected(activeSession);
    refreshNewest();
  }, [activeSession, callState, refreshNewest]);

  // The selected session in list terms, resolving older call ids to their session.
  const matchingDetail = detail && selected && (detail.session.id === selected || detail.session.callIds.includes(selected)) ? detail : null;
  const current = selected ? (matchingDetail?.session ?? resolveSession(sessions, selected)) : null;
  const isSelectedLive = !!current && (
    (callState !== "idle" && activeSession !== null && current.id === activeSession) ||
    (activeCallId !== null && current.callIds.includes(activeCallId)) ||
    (activeCallId !== null && current.id === activeCallId) ||
    current.currentCallNonce !== null
  );

  // Live updates: the server publishes on every logged event, keyed by call.
  useRealtime("aide-log", (payload) => {
    refreshNewest();
    const callId = (payload as { sessionId?: unknown } | null)?.sessionId;
    if (!selected || typeof callId !== "string") return;
    if (selected === callId || current?.callIds.includes(callId) || (activeCallId === callId && isSelectedLive)) refetchDetail(selected);
  });
  useRealtime("voice-coordinator", () => refreshNewest());

  useEffect(() => {
    const el = scrollRef.current;
    if (!selected || !el || detailLoading || !detail || detail.events.length === 0) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (pendingBottom.current || nearBottom) {
      el.scrollTop = el.scrollHeight;
      pendingBottom.current = false;
    }
  }, [detail, selected, detailLoading, tab]);

  const startNew = () => {
    if (voiceAgent.getState() !== "idle") return;
    startRequested.current = true;
    startConversation();
  };
  const continueSelected = () => {
    if (!current) return;
    if (callState !== "idle") {
      toast.error("End the current call before continuing another session.");
      return;
    }
    startRequested.current = true;
    startConversation(current.id);
  };
  const viewLive = (callId: string) => setSelected(activeConversationId() ?? resolveSession(sessions, callId)?.id ?? callId);

  const query = search.trim().toLowerCase();
  const visibleSessions = sessions?.filter(
    (session) => !query || session.title.toLowerCase().includes(query) || fmtDate(session.updatedAt).toLowerCase().includes(query),
  );
  const isLive = (session: VoiceSessionRow): boolean =>
    session.currentCallNonce !== null || (callState !== "idle" && session.id === activeSession) || (activeCallId !== null && (session.callIds.includes(activeCallId) || session.id === activeCallId));

  return (
    <div className="voice-sessions flex h-full min-h-0 flex-col">
      {selected ? (
        <nav aria-label="Session navigation" className="shrink-0 border-b border-border bg-background px-4 py-2 sm:py-3 md:px-6">
          <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-1.5 sm:gap-2">
            <Button ref={backButtonRef} type="button" variant="outline" size="sm" onClick={backToSessions} className="min-h-11 shrink-0 sm:min-h-8">
              ← All sessions
            </Button>
            <div role="tablist" aria-label="Session views" className="flex max-w-full flex-wrap items-center gap-1 sm:rounded-md sm:border sm:border-border sm:p-1">
              {SESSION_TABS.map((entry) => (
                <Button
                  key={entry.id}
                  type="button"
                  role="tab"
                  size="sm"
                  variant="ghost"
                  aria-selected={tab === entry.id}
                  onClick={() => setTab(entry.id)}
                  className={cn("min-h-11 px-2 sm:min-h-8", tab === entry.id ? "bg-accent text-foreground" : "text-muted-foreground")}
                >
                  {entry.label}
                </Button>
              ))}
            </div>
          </div>
        </nav>
      ) : null}
      <div role="region" aria-label="Session content" ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 md:p-6">
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
        {error ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 p-3 text-sm">
            <span className="min-w-0 break-words text-destructive">Could not load sessions. {error}</span>
            <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={refreshNewest}>Retry sessions</Button>
          </div>
        ) : null}
        {selected ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-3.5 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                {isSelectedLive ? <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-primary" /> : null}
                <div className="min-w-0 leading-tight">
                  <div className="truncate text-sm font-medium text-foreground">{current?.title ?? "Voice session"}</div>
                  <div className="text-xs text-muted-foreground">
                    {current ? `${isSelectedLive ? "Live now" : "Ended"} · ${fmtDate(current.createdAt)}` : "Loading…"}
                    {current && current.callIds.length > 1 ? ` · ${current.callIds.length} calls` : ""}
                    {current?.legacy ? " · single call" : ""}
                  </div>
                </div>
              </div>
              {current && !isSelectedLive ? (
                <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={continueSelected} aria-label="Continue this session">
                  <WaveformIcon live={false} />
                  Continue
                </Button>
              ) : null}
            </div>
            <div aria-label="Session detail" aria-busy={detailLoading} className="min-w-0 py-1">
              {detailError ? (
                <div role="alert" className="space-y-3 rounded-md border border-destructive/30 p-4">
                  <p className="break-words text-sm text-destructive">Could not load the session. {detailError}</p>
                  <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => refetchDetail(selected, true)}>Retry session</Button>
                </div>
              ) : tab === "coordinator" ? (
                <CoordinatorCard conversationId={current && !current.legacy ? current.id : null} legacy={current?.legacy ?? false} />
              ) : detailLoading || !detail ? (
                <p role="status" className="py-4 text-center text-sm text-muted-foreground">Loading session…</p>
              ) : tab === "conversation" ? (
                <ConversationView events={detail.events} live={isSelectedLive} />
              ) : (
                <div className="space-y-2">
                  <FilterBar value={filter} onChange={setFilter} />
                  {detail.events.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">No events were recorded for this session.</p>
                  ) : (
                    <TranscriptBody events={detail.events} plugins={plugins} filter={filter} />
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <h2 ref={historyHeadingRef} tabIndex={-1} className="min-w-0 rounded-sm text-base font-semibold leading-tight text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">Voice sessions</h2>
              <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={openVoiceModeSettings}
                  aria-label="Open Voice Mode settings"
                  className="size-11 p-0 text-muted-foreground sm:size-8"
                >
                  <GearIcon />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={callState !== "idle"}
                  onClick={startNew}
                  className="min-h-11 sm:min-h-8"
                >
                  <WaveformIcon live={false} />
                  {callState === "idle" ? "New session" : callState === "connecting" ? "Connecting…" : "Session in progress"}
                </Button>
              </div>
            </div>
            {sessions && sessions.length > 0 ? (
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search sessions…"
                aria-label="Search sessions"
                className="min-h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring sm:min-h-9"
              />
            ) : null}
            {sessions !== null || !error ? (
            <div aria-label="Session history" className="divide-y divide-border rounded-lg border border-border">
              {sessions === null ? (
                <p role="status" className="p-4 text-sm text-muted-foreground">Loading sessions…</p>
              ) : sessions.length === 0 ? (
                <div className="space-y-2 px-4 py-8 text-center">
                  <h3 className="text-sm font-medium text-foreground">No voice sessions yet</h3>
                  <p className="mx-auto max-w-sm text-sm text-muted-foreground">Start a new session to talk to your agents. Your conversations will appear here.</p>
                </div>
              ) : visibleSessions && visibleSessions.length === 0 ? (
                <div className="space-y-2 p-4 text-center">
                  <p className="text-sm text-muted-foreground">No sessions match.</p>
                  <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setSearch("")}>Clear filters</Button>
                </div>
              ) : (
                visibleSessions?.map((session) => (
                  <button
                    key={session.id}
                    ref={(node) => {
                      if (node) sessionButtons.current.set(session.id, node);
                      else sessionButtons.current.delete(session.id);
                    }}
                    type="button"
                    onClick={() => setSelected(session.id)}
                    className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left first:rounded-t-lg last:rounded-b-lg hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 break-words text-sm text-foreground sm:block sm:truncate">{session.title}</span>
                      <span className="mt-1 block text-xs tabular-nums text-muted-foreground">
                        {fmtDate(session.updatedAt)}
                        {session.callIds.length > 1 ? ` · ${session.callIds.length} calls` : ""}
                        {session.legacy ? " · single call" : ""}
                      </span>
                    </span>
                    {isLive(session) ? (
                      <span className="flex shrink-0 items-center" title="Live session">
                        <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-primary" />
                        <span className="sr-only">Live session</span>
                      </span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
            ) : null}
            {hasMore ? (
              <div className="flex justify-center">
                <Button type="button" variant="outline" size="sm" onClick={loadMore} disabled={loadingMore} className="min-h-11 sm:min-h-8">
                  {loadingMore ? "Loading…" : "Load more sessions"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
      </div>
      {callState !== "idle" ? (
        <section aria-label="Current voice session" className="shrink-0 border-t border-border bg-background px-4 py-3">
          <div className="mx-auto flex w-full max-w-3xl justify-center">
            <CallConsole onViewTranscript={viewLive} viewingLive={selected !== null && isSelectedLive} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
