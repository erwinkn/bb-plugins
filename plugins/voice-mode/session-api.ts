// Typed access to the logical-session rpc methods and the voice agent's
// session controls. Calls use the server contract directly; there is no
// fallback that could continue a different session.
import type { SessionEvent } from "./session-projection.ts";
import type { ConversationWork } from "./conversation-work.ts";
import { voiceAgent } from "./voice-agent";

export interface VoiceSessionRow {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  coordinatorThreadId: string | null;
  callIds: string[];
  currentCallNonce: string | null;
  /** A pre-coordinator physical call, kept as its own session. */
  legacy: boolean;
}

export interface ListVoiceSessionsResult {
  sessions: VoiceSessionRow[];
  hasMore: boolean;
}

export interface VoiceSessionDetail {
  session: VoiceSessionRow;
  events: (SessionEvent & { callId: string })[];
  work: ConversationWork;
}

/** Typed directly against the server contract; selection never falls back to another call. */
export function sessionApi(rpc: ReturnType<typeof import("@get-bb/plugin-sdk/app").useRpc<typeof import("./server.ts").rpcContract>>) {
  return {
    list: (before: {updatedAt:number;id:string}|null) => rpc.call("listVoiceSessions", before ? {before} : null),
    get: (sessionId:string) => rpc.call("getVoiceSession", {sessionId}),
  };
}
export function startConversation(conversationId?:string):void { voiceAgent.startConversation(conversationId); }
export function activeConversationId():string|null { return voiceAgent.getConversationId(); }

/** Resolve a selection (session id or an older physical call id) to a listed session. */
export function resolveSession(rows: readonly VoiceSessionRow[] | null, selectedId: string): VoiceSessionRow | null {
  if (!rows) return null;
  return rows.find((row) => row.id === selectedId) ?? rows.find((row) => row.callIds.includes(selectedId)) ?? null;
}
