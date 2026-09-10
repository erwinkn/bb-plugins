import { importLegacyWatches } from "./legacy-watch-import.ts";
import { ConversationRecord } from "./conversation-record.ts";
import { CONVERSATION_HISTORY_MIGRATIONS, QUICK_ACTION_MIGRATIONS, UI_COMMAND_MIGRATIONS } from "./legacy-migrations.ts";
import { liveToolSchemas } from "./live-tools.ts";
import { PromptStore, promptDefault } from "./prompt-store.ts";
import { voiceFeatureMigrations } from "./migration-order.ts";
import { LiveRuntime, liveRpcContract } from "./live-runtime.ts";
import { conversationWorkSchema, readConversationWork } from "./conversation-work.ts";
import { loadWorkerCatalog, workerCatalogSchema } from "./provider-catalog.ts";
import { readNamedWorkerSettings, namedWorkerSettingsSchema, NAMED_WORKER_PROFILE_KEY, migrateWorkerSettings, validateNamedWorkerSettings } from "./worker-profiles.ts";
import { EMPTY_TRANSCRIPT, transcriptSnapshotSchema, type TranscriptSnapshot } from "./live-transcript.ts";
import { VoiceSessions, voiceSessionSchema } from "./voice-sessions.ts";
// bb-plugin-voice-mode — Ada: a realtime voice operator for bb.
//
// The frontend (app.tsx) captures mic audio over WebRTC directly in the bb
// app; this backend holds the OpenAI API key, performs the SDP exchange with
// the OpenAI Realtime API, and executes the voice agent's tools against the
// bb SDK (threads, projects, diffs, panes).
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  MODEL_OPTIONS,
  VOICE_OPTIONS,
  isModel,
  isVoice,
  type RealtimeModel,
  type Voice,
} from "./models";
import { sessionEventLog } from "./session-events.ts";
import { DEFAULT_SHORTCUTS, isValidShortcut, normalizeShortcuts, type Shortcuts } from "./shortcuts";

/**
 * Rebindable keyboard shortcuts (see shortcuts.ts): each value is a
 * "Mod+Shift+H"-style string that includes Mod or Alt, or is a function key,
 * so it can't fire while the user is merely typing.
 */
const shortcutsSchema = z
  .object({
    toggle: z.string().max(60).refine(isValidShortcut, "not a usable key combination"),
    mute: z.string().max(60).refine(isValidShortcut, "not a usable key combination"),
  })
  .strict();

export const rpcContract = defineRpcContract({
  ...liveRpcContract,
  listWorkerProviders: {input:z.object({hostId:z.string().min(1).max(128).optional()}).strict(),output:workerCatalogSchema},
  getWorkerSettings: { input:z.null(),output:namedWorkerSettingsSchema },
  setWorkerSettings: { input:z.object({settings:namedWorkerSettingsSchema,hostId:z.string().min(1).max(128)}).strict(),output:namedWorkerSettingsSchema },
  claimCall: {
    input: z
      .object({
        nonce: z.string().min(1).max(256),
        /** Start a separate logical conversation instead of resuming the last one. */
        newConversation: z.boolean().optional(),
        transferFromNonce: z.string().min(1).max(256).optional(),
        conversationId: z.string().min(1).optional(),
        threadId: z.string().nullable().optional(),
        projectId: z.string().nullable().optional(),
      })
      .strict(),
    output: z
      .object({
        sequence: z.number(),
        /** The logical conversation that owns this call. */
        conversationId: z.string().nullable(),
        voiceSessionId: z.string(),
        resumed: z.boolean(),
      })
      .strict(),
  },
  reconnectCall: {
    input: z.object({ nonce: z.string().min(1).max(256), previousNonce: z.string().min(1).max(256) }).strict(),
    output: z.object({ sequence: z.number(), conversationId: z.string(), voiceSessionId: z.string(), resumed: z.boolean() }).strict().nullable(),
  },
  /** Exchange a WebRTC SDP offer with OpenAI Realtime. Returns the answer. */
  createCall: {
    input: z
      .object({
        sdp: z.string().min(1),
        threadId: z.string().nullable(),
        projectId: z.string().nullable(),
        /** True when the user is on the New thread screen (no thread yet). */
        onNewThreadScreen: z.boolean().optional(),
        /** Device policy is fixed for the call, independently of its entry point. */
        mobile: z.boolean().optional(),
        /** Unique per call; broadcast so every other window ends its session. */
        nonce: z.string().min(1),
      })
      .strict(),
    output: z.object({ sdp: z.string() }).strict(),
  },
  /** Record token usage from one realtime response.done event. */
  recordUsage: {
    input: z
      .object({
        model: z.string().nullable(),
        sessionId: z.string().nullable(),
        usage: z.record(z.string(), z.unknown()),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** Active prompt, the built-in default, and version history. */
  getPrompt: {
    input: z.object({role:z.enum(["aide","live","worker","coordinator"])}).strict().nullable(),
    output: z
      .object({
        content: z.string(),
        defaultContent: z.string(),
        proposal: z.object({ id: z.string(), content: z.string(), reason: z.string() }).nullable(),
        versions: z.array(
          z
            .object({
              id: z.number(),
              ts: z.number(),
              source: z.string(),
              note: z.string().nullable(),
              content: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  /** Save a new prompt version (becomes active for the next session). */
  setPrompt: {
    input: z
      .object({
        role:z.enum(["aide","live","worker","coordinator"]).optional(),
        content: z.string().min(1).max(32000),
        source: z.literal("user"),
        proposalId: z.string().optional(),
        note: z.string().nullable(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** Effective non-secret config for new voice sessions (kv-backed). */
  getConfig: {
    input: z.null(),
    output: z
      .object({
        model: z.enum(MODEL_OPTIONS),
        voice: z.enum(VOICE_OPTIONS),
        credentialPreference: z.enum(["auto", "apiKey", "subscription"]),
        shortcuts: shortcutsSchema,
      })
      .strict(),
  },
  /** Update one or more config fields for new voice sessions. */
  setConfig: {
    input: z
      .object({
        model: z.enum(MODEL_OPTIONS).optional(),
        voice: z.enum(VOICE_OPTIONS).optional(),
        credentialPreference: z.enum(["auto", "apiKey", "subscription"]).optional(),
        shortcuts: shortcutsSchema.optional(),
      })
      .strict(),
    output: z
      .object({
        model: z.enum(MODEL_OPTIONS),
        voice: z.enum(VOICE_OPTIONS),
        credentialPreference: z.enum(["auto", "apiKey", "subscription"]),
        shortcuts: shortcutsSchema,
      })
      .strict(),
  },
  /** Clear the stored OpenAI API key (falls back to env / subscription). */
  clearApiKey: {
    input: z.null(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** Which credential the backend will use for new voice sessions. */
  getCredentialStatus: {
    input: z.null(),
    output: z
      .object({
        /** The credential apiKey() will actually pick right now. */
        effective: z.enum(["apiKey", "env", "subscription", "none"]),
        /** The user's stored preference; "auto" follows precedence. */
        preference: z.enum(["auto", "apiKey", "subscription"]),
        hasApiKey: z.boolean(),
        envKeyPresent: z.boolean(),
        subscriptionAvailable: z.boolean(),
      })
      .strict(),
  },
  /** Append one event to a voice session's transcript log. */
  getLiveTranscript: { input: z.null(), output: transcriptSnapshotSchema },
  publishTranscript: { input: transcriptSnapshotSchema, output: z.object({ ok: z.boolean() }) },
  logEvent: {
    input: z
      .object({
        sessionId: z.string().min(1).max(256),
        kind: z.string().min(1).max(128),
        payload: z.record(z.string(), z.unknown()).refine(value => Buffer.byteLength(JSON.stringify(value), "utf8") <= 65536, "Event payload exceeds 64 KiB"),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /**
   * Broadcast a live call's coarse presence to every surface/realm. The owning
   * realm (the one holding the WebRTC session) publishes on each state change
   * and on a heartbeat; other realms mirror it so their composer pill / sidebar
   * bar reflect the call they don't own. Pure pass-through to realtime.
   */
  publishPresence: {
    input: z
      .object({
        nonce: z.string().min(1),
        phase: z.enum(["connecting", "reconnecting", "live", "muted", "idle"]),
        startedAt: z.number().nullable(),
        /** Which client/realm owns this call (observability; see client-identity). */
        client: z.string().optional(),
        realm: z.string().optional(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /**
   * Ask whoever owns a live call to re-announce its presence right now. A
   * freshly mounted surface (e.g. a page realm rebuilt after mobile navigation)
   * fires this so it catches up immediately instead of waiting up to a full
   * heartbeat — otherwise it briefly shows "idle" over a call that is live.
   */
  requestPresence: {
    input: z.null(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /**
   * Relay a control intent (stop/mute/unmute) from a surface that does NOT own
   * the call to the realm that does. Only the owner (matching nonce) acts on it.
   */
  sendVoiceCommand: {
    input: z
      .object({
        nonce: z.string().min(1),
        action: z.enum(["stop", "mute", "unmute"]),
        /** Which client/realm issued the command (observability). */
        client: z.string().optional(),
        realm: z.string().optional(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /**
   * End a call authoritatively, without needing its owner realm to act — the
   * owner may be a frozen, backgrounded mobile webview that can no longer receive
   * commands. Marks the session stopped (so the list stops showing it live) and
   * broadcasts idle + a stop so every surface clears and the owner tears down if
   * it ever thaws. This is what makes stop reliable against the navigation zombie.
   */
  forceStop: {
    input: z.object({ nonce: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** List logical voice conversations, newest first, including historical calls. */
  listVoiceSessions: { input: z.object({before: z.object({updatedAt:z.number(),id:z.string()}).strict().optional()}).strict().nullable(), output: z.object({sessions:z.array(voiceSessionSchema),hasMore:z.boolean()}).strict() },
  getVoiceSession: { input:z.object({sessionId:z.string()}).strict(), output:z.object({session:voiceSessionSchema,events:z.array(z.object({id:z.number(),ts:z.number(),kind:z.string(),payload:z.string(),callId:z.string()}).strict()),work:conversationWorkSchema}).strict() },

});

const REALTIME_ENDPOINT = "https://api.openai.com/v1/realtime/calls";

// USD per 1M tokens for the gpt-realtime family (openai.com/api/pricing,
// checked 2026-02). Cached input (text or audio) is a flat $0.40.
const RATES = {
  textIn: 4,
  audioIn: 32,
  cachedIn: 0.4,
  textOut: 16,
  audioOut: 64,
};

interface UsageRow {
  ts: number;
  model: string;
  input_text: number;
  input_audio: number;
  cached_text: number;
  cached_audio: number;
  output_text: number;
  output_audio: number;
}

/** Estimated USD cost of one usage row at current RATES. */
function costUsd(row: UsageRow): number {
  const uncachedText = Math.max(0, row.input_text - row.cached_text);
  const uncachedAudio = Math.max(0, row.input_audio - row.cached_audio);
  return (
    (uncachedText * RATES.textIn +
      uncachedAudio * RATES.audioIn +
      (row.cached_text + row.cached_audio) * RATES.cachedIn +
      row.output_text * RATES.textOut +
      row.output_audio * RATES.audioOut) /
    1_000_000
  );
}

function truncate(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  const commonMigrations = [
    `CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_text INTEGER NOT NULL DEFAULT 0,
      input_audio INTEGER NOT NULL DEFAULT 0,
      cached_text INTEGER NOT NULL DEFAULT 0,
      cached_audio INTEGER NOT NULL DEFAULT 0,
      output_text INTEGER NOT NULL DEFAULT 0,
      output_audio INTEGER NOT NULL DEFAULT 0
    )`,
    `ALTER TABLE usage_events ADD COLUMN session_id TEXT`,
    `CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    )`,
    `CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events (session_id, ts)`,
    `CREATE TABLE IF NOT EXISTS prompt_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      note TEXT,
      content TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS voice_call_control (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      sequence INTEGER NOT NULL,
      nonce TEXT
    )`,
    `INSERT OR IGNORE INTO voice_call_control (slot, sequence, nonce) VALUES (1, 0, NULL)`,
    `CREATE TABLE IF NOT EXISTS prompt_proposals (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      id TEXT NOT NULL,
      content TEXT NOT NULL,
      reason TEXT NOT NULL
    )`,
    ...CONVERSATION_HISTORY_MIGRATIONS,
    ...UI_COMMAND_MIGRATIONS,
    ...QUICK_ACTION_MIGRATIONS,
  ];
  bb.storage.migrate(db, [...commonMigrations, ...voiceFeatureMigrations(db, commonMigrations.length)]);
  await migrateWorkerSettings(bb);
  const prompts = new PromptStore(db);

  // Reject new event data at the quota; never silently delete saved transcripts.
  const EVENT_STORAGE_LIMIT = 128 * 1024 * 1024;
  const EVENT_COUNT_LIMIT = 100_000;
  const usage = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(payload AS BLOB)) + length(CAST(session_id AS BLOB)) + length(CAST(kind AS BLOB))), 0) AS bytes FROM session_events").get() as { count: number; bytes: number };
  let eventCount = usage.count;
  let eventBytes = usage.bytes;
  function appendEvent(sessionId: string, kind: string, payload: Record<string, unknown>) {
    const text = JSON.stringify(payload);
    const bytes = Buffer.byteLength(text + sessionId + kind, "utf8");
    if (eventCount >= EVENT_COUNT_LIMIT || eventBytes + bytes > EVENT_STORAGE_LIMIT) {
      throw new Error("Voice event storage is full. Export and clear old session events before logging more.");
    }
    const ts = Date.now();
    const result = db.prepare("INSERT INTO session_events (session_id, ts, kind, payload) VALUES (?, ?, ?, ?)").run(sessionId, ts, kind, text);
    eventCount += 1;
    eventBytes += bytes;
    return { ts, id: Number(result.lastInsertRowid) };
  }

  let liveTranscript: TranscriptSnapshot = EMPTY_TRANSCRIPT;
  const conversations = new ConversationRecord(db);
  const voiceSessions = new VoiceSessions(db);
  const currentCall = () => db.prepare("SELECT sequence, nonce FROM voice_call_control WHERE slot = 1").get() as { sequence: number; nonce: string | null };
  const liveRuntime = new LiveRuntime(bb, () => {
    const { nonce } = currentCall();
    const link = nonce ? db.prepare("SELECT conversation_id FROM voice_conversation_calls WHERE call_id = ?").get(nonce) as { conversation_id: string } | undefined : undefined;
    return { nonce, conversationId: link?.conversation_id };
  }, Date.now, 30000, () => prompts.read("worker"));
  for (const name of ["thread.active", "thread.idle", "thread.failed", "thread.archived", "interaction.pending", "message.dispatched"] as const) {
    bb.events.on(name, payload => liveRuntime.watches.event(name, payload).catch(error => bb.log.warn(`Live runtime event failed: ${error instanceof Error ? error.message : String(error)}`)));
  }
  // Startup must not fail on a transient SDK error. The import keeps its marker unset and retries next start.
  try { await importLegacyWatches(bb, liveRuntime.watches); }
  catch (error) { bb.log.warn(`Legacy watch import deferred to the next start: ${error instanceof Error ? error.message : String(error)}`); }
  try { await liveRuntime.initialize(); }
  catch (error) { bb.log.warn(`Live runtime recovery failed at startup: ${error instanceof Error ? error.message : String(error)}`); }
  function forceStopCall(nonce: string, transferring = false) {
    db.prepare("UPDATE voice_call_control SET nonce = NULL WHERE nonce = ?").run(nonce);
    conversations.endCall(nonce);
    try { appendEvent(nonce, "session.stopped", { _forced: true }); }
    catch (error) { bb.log.warn(String(error)); }
    bb.realtime.publish("voice-presence", { nonce, phase: "idle", startedAt: null });
    bb.realtime.publish("voice-command", { nonce, action: "stop" });
    bb.realtime.publish("aide-log", { sessionId: nonce });
  }

  // The API key is the ONE declarative setting: secrets must live here to get
  // 0600-file storage that never touches the db or the frontend. Everything
  // else the user configures — model, voice, behavior — is kv-backed below and
  // rendered by our own polished settings sections, so the host's auto-form
  // stays a single clean field instead of a flat dump.
  const settings = bb.settings.define({
    openaiApiKey: {
      type: "string",
      label: "OpenAI API key (optional)",
      secret: true,
      description: "Leave blank to use your ChatGPT subscription instead (run `codex login`).",
    },
  });

  // ---- kv-backed voice-session config (model / voice / behavior) ----
  // "auto" keeps the historical precedence (key → env → subscription); the
  // user can pin it to one credential when more than one is available.
  type CredentialPreference = "auto" | "apiKey" | "subscription";
  const CREDENTIAL_PREFERENCES: readonly CredentialPreference[] = ["auto", "apiKey", "subscription"];
  const isCredentialPreference = (value: unknown): value is CredentialPreference =>
    typeof value === "string" && (CREDENTIAL_PREFERENCES as readonly string[]).includes(value);

  interface VoiceConfig {
    model: RealtimeModel;
    voice: Voice;
    credentialPreference: CredentialPreference;
    shortcuts: Shortcuts;
  }
  const CONFIG_KEY = "config";
  const CONFIG_DEFAULTS: VoiceConfig = {
    model: DEFAULT_MODEL,
    voice: DEFAULT_VOICE,
    credentialPreference: "auto",
    shortcuts: { ...DEFAULT_SHORTCUTS },
  };
  async function readConfig(): Promise<VoiceConfig> {
    const stored = (await bb.storage.kv.get<Partial<VoiceConfig>>(CONFIG_KEY)) ?? {};
    return {
      model: isModel(stored.model) ? stored.model : CONFIG_DEFAULTS.model,
      voice: isVoice(stored.voice) ? stored.voice : CONFIG_DEFAULTS.voice,
      credentialPreference: isCredentialPreference(stored.credentialPreference)
        ? stored.credentialPreference
        : CONFIG_DEFAULTS.credentialPreference,
      shortcuts: normalizeShortcuts(stored.shortcuts),
    };
  }
  let configWrite: Promise<unknown> = Promise.resolve();
  function writeConfig(patch: Partial<VoiceConfig>): Promise<VoiceConfig> {
    if (patch.shortcuts) patch = { ...patch, shortcuts: normalizeShortcuts(patch.shortcuts) };
    const result = configWrite.then(async () => {
      const current = await readConfig();
      const next: VoiceConfig = {
        ...current,
        ...patch,
      };
      await bb.storage.kv.set(CONFIG_KEY, { ...await bb.storage.kv.get<Record<string,unknown>>(CONFIG_KEY), ...next });
      return next;
    });
    // A failed write rejects its caller, but must not block future updates.
    configWrite = result.catch(() => undefined);
    return result;
  }

  // One-time migration: earlier versions stored model and voice
  // as declarative settings. Carry customized values into
  // kv so removing those descriptors doesn't silently reset them.
  if (!(await bb.storage.kv.get<boolean>("config.migrated"))) {
    try {
      const legacy = await bb.sdk.plugins.getSettings({ pluginId: bb.pluginId });
      const v = (legacy?.values ?? {}) as Record<string, unknown>;
      const patch: Partial<VoiceConfig> = {};
      if (isModel(v.model)) patch.model = v.model;
      if (isVoice(v.voice)) patch.voice = v.voice;
      if (Object.keys(patch).length > 0) await writeConfig(patch);
    } catch (error) {
      bb.log.warn(`config migration skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    await bb.storage.kv.set("config.migrated", true);
  }

  // ---- Codex subscription auth ----
  // The OpenAI Realtime endpoints accept the ChatGPT-subscription OAuth
  // access token that Codex CLI stores in ~/.codex/auth.json (its audience is
  // literally https://api.openai.com/v1). We use it as a fallback when no API
  // key is configured, refreshing it via the Codex OAuth client when expired.
  const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
  const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

  function jwtExp(token: string): number {
    try {
      const payload = token.split(".")[1];
      const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      return typeof json.exp === "number" ? json.exp : 0;
    } catch {
      return 0;
    }
  }

  async function codexToken(): Promise<string | null> {
    let auth: { tokens?: { access_token?: string; refresh_token?: string } };
    try {
      auth = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf8"));
    } catch {
      return null;
    }
    const access = auth.tokens?.access_token;
    const refresh = auth.tokens?.refresh_token;
    if (!access) return null;
    if (jwtExp(access) - 60 > Date.now() / 1000) return access;
    if (!refresh) return null;
    try {
      const response = await fetch("https://auth.openai.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: CODEX_CLIENT_ID,
          refresh_token: refresh,
          scope: "openid profile email",
        }),
      });
      if (!response.ok) {
        bb.log.error(`codex token refresh failed: ${response.status}`);
        return null;
      }
      const fresh = (await response.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
      if (!fresh.access_token) return null;
      // Persist back like Codex CLI does, so both tools stay in sync.
      const updated = {
        ...auth,
        tokens: {
          ...auth.tokens,
          access_token: fresh.access_token,
          refresh_token: fresh.refresh_token ?? refresh,
          ...(fresh.id_token ? { id_token: fresh.id_token } : {}),
        },
        last_refresh: new Date().toISOString(),
      };
      try {
        writeFileSync(CODEX_AUTH_PATH, JSON.stringify(updated, null, 2));
      } catch {
        // Read-only auth file is fine; the token still works for this session.
      }
      return fresh.access_token;
    } catch (error) {
      bb.log.error(`codex token refresh error: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function apiKey(): Promise<string> {
    const { openaiApiKey } = await settings.get();
    const { credentialPreference } = await readConfig();
    const key = openaiApiKey || process.env.OPENAI_API_KEY;
    // When the user pinned the subscription, try it first and only fall back to
    // a key. Otherwise (auto / apiKey) a key wins, then the subscription.
    if (credentialPreference === "subscription") {
      const codex = await codexToken();
      if (codex) return codex;
      if (key) return key;
    } else {
      if (key) return key;
      const codex = await codexToken();
      if (codex) return codex;
    }
    throw new Error(
      "No OpenAI credentials. Set an API key in the Voice Mode settings, or sign in with `codex login` to use your ChatGPT subscription.",
    );
  }

  {
    const { openaiApiKey } = await settings.get();
    if (!openaiApiKey && !process.env.OPENAI_API_KEY && !(await codexToken())) {
      bb.status.needsConfiguration("Set openaiApiKey with `bb plugin config voice-mode set openaiApiKey <key>`, or run `codex login`, then reload.");
    }
  }

  const LIVE_STATUSES = new Set([
    "active",
    "starting",
    "stopping",
    "provisioning",
    "waiting-for-host",
    "host-reconnecting",
  ]);

  // Matches the sidebar's Live threads definition (active-threads plugin):
  // running now, or finished within this window (shown as "recently-finished").
  const RECENT_WINDOW_MS = 30 * 60_000;

  /** Threads that are live right now or finished recently, newest first. */
  async function liveThreads() {
    const [threads, projects] = await Promise.all([
      bb.sdk.threads.list({ limit: 200 }),
      bb.sdk.projects.list({ includePersonal: true }),
    ]);
    const projectNames = new Map(projects.map((p) => [p.id, p.name]));
    const now = Date.now();
    return threads
      .filter((t) => {
        if (t.archivedAt) return false;
        if (LIVE_STATUSES.has(t.runtime.displayStatus)) return true;
        return now - t.updatedAt <= RECENT_WINDOW_MS;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => ({
        id: t.id,
        parentThreadId: t.parentThreadId ?? null,
        title: t.title ?? t.titleFallback ?? "(untitled)",
        status: LIVE_STATUSES.has(t.runtime.displayStatus)
          ? t.runtime.displayStatus
          : `recently-finished (${t.runtime.displayStatus}, ${relativeTime(t.updatedAt)})`,
        project: projectNames.get(t.projectId) ?? t.projectId,
        projectId: t.projectId,
        providerId: t.providerId,
        updatedAt: t.updatedAt,
        environmentId: t.environmentId ?? null,
      }));
  }

  function relativeTime(timestamp: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  bb.cli.register({
    name: "voice-mode",
    summary: "Voice Mode plugin: inspect live threads and voice sessions",
    commands: [
      { name: "actions", summary: "Inspect recent recorded Voice effects for the current conversation.", usage: "bb voice-mode actions [--json]" },
      { name: "workers", summary: "Inspect up to 200 Voice workers, including unconfirmed creations.", usage: "bb voice-mode workers [--json]" },
      { name: "live", summary: "List live threads: running now plus recently finished (last 30 min), like the sidebar. Add --json for machine output.", usage: "bb voice-mode live [--json]" },
      { name: "read", summary: "Read a thread's status and latest assistant output.", usage: "bb voice-mode read <thread-id>" },
      { name: "usage", summary: "Voice-session token usage and estimated cost, grouped per day. Add --json for machine output, --days N to limit the window.", usage: "bb voice-mode usage [--days N] [--json]" },
      { name: "stop", summary: "Stop any active Ada voice session in any bb window.", usage: "bb voice-mode stop" },
      { name: "mute", summary: "Mute the active voice session's microphone (call stays up).", usage: "bb voice-mode mute" },
      { name: "unmute", summary: "Unmute the active voice session's microphone.", usage: "bb voice-mode unmute" },
    ],
    async run(argv) {
      const [command, ...rest] = argv;
      const help = [
        "Voice Mode \u2014 voice operator for bb",
        "",
        "Usage:",
        "  bb voice-mode actions [--json]        recent effect receipts",
        "  bb voice-mode workers [--json]        workers and uncertain creations",
        "  bb voice-mode live [--json]           threads that are live right now",
        "  bb voice-mode read <thread-id>        thread status + latest assistant output",
        "  bb voice-mode usage [--days N] [--json] voice-session tokens and estimated cost",
        "  bb voice-mode stop                    stop any active voice session",
        "  bb voice-mode mute | unmute           mute/unmute the active session's mic",
      ].join("\n");
      try {
        if (command === undefined || command === "help" || command === "--help" || command === "-h") {
          return { exitCode: 0, stdout: help };
        }
        if (command === "mute" || command === "unmute") {
          bb.realtime.publish("voice-mute", { muted: command === "mute" });
          return { exitCode: 0, stdout: `${command === "mute" ? "Mute" : "Unmute"} signal broadcast.` };
        }
        if (command === "stop") {
          const { nonce } = currentCall();
          if (nonce) forceStopCall(nonce);
          // Also stop clients still waiting for a claim response.
          bb.realtime.publish("voice-call", { nonce: `cli-stop-${Date.now()}` });
          return { exitCode: 0, stdout: "Stop signal broadcast to all bb windows." };
        }
        if (command === "actions" || command === "workers") {
          const conversationId=conversations.currentConversationId();
          const data = command === "workers" ? {tasks:liveRuntime.store.tasks(conversationId ?? undefined)}
            : {conversationId,operations:conversationId ? db.prepare("SELECT id,tool,status,receipt_json FROM voice_operations WHERE conversation_id=? ORDER BY created_at DESC LIMIT 200").all(conversationId) : []};
          return {exitCode:0,stdout:JSON.stringify(data,null,2)};
        }
        if (command === "live") {
          const live = await liveThreads();
          if (rest.includes("--json") || argv.includes("--json")) {
            return { exitCode: 0, stdout: JSON.stringify(live, null, 2) };
          }
          if (live.length === 0) return { exitCode: 0, stdout: "No live threads right now." };
          const lines = live.map(
            (t) => `${t.id}  [${t.status}]  ${t.title}  (${t.project} \u00b7 ${t.providerId} \u00b7 ${relativeTime(t.updatedAt)})`,
          );
          return { exitCode: 0, stdout: `${live.length} live thread(s):\n${lines.join("\n")}` };
        }
        if (command === "read") {
          const threadId = rest.find((arg) => !arg.startsWith("-"));
          if (!threadId) return { exitCode: 1, stderr: "Usage: bb voice-mode read <thread-id>" };
          const thread = await bb.sdk.threads.get({ threadId });
          const { output } = await bb.sdk.threads.output({ threadId });
          const t = thread as { title?: string | null; status?: string };
          const header = `${threadId}  [${t.status ?? "?"}]  ${t.title ?? "(untitled)"}`;
          return { exitCode: 0, stdout: `${header}\n\n${output ? truncate(output, 20000) : "(no assistant output yet)"}` };
        }
        if (command === "usage") {
          const daysFlag = rest.indexOf("--days");
          const days = daysFlag >= 0 ? Number(rest[daysFlag + 1]) || 30 : 30;
          const since = Date.now() - days * 86_400_000;
          const rows = db
            .prepare("SELECT * FROM usage_events WHERE ts >= ? ORDER BY ts")
            .all(since) as UsageRow[];
          const byDay = new Map<string, { responses: number; audioIn: number; audioOut: number; textIn: number; textOut: number; cached: number; cost: number }>();
          for (const row of rows) {
            const day = new Date(row.ts).toISOString().slice(0, 10);
            const entry = byDay.get(day) ?? { responses: 0, audioIn: 0, audioOut: 0, textIn: 0, textOut: 0, cached: 0, cost: 0 };
            entry.responses += 1;
            entry.audioIn += row.input_audio;
            entry.audioOut += row.output_audio;
            entry.textIn += row.input_text;
            entry.textOut += row.output_text;
            entry.cached += row.cached_text + row.cached_audio;
            entry.cost += costUsd(row);
            byDay.set(day, entry);
          }
          const daysOut = [...byDay.entries()].map(([day, e]) => ({ day, ...e, cost: Number(e.cost.toFixed(4)) }));
          const total = Number(daysOut.reduce((sum, d) => sum + d.cost, 0).toFixed(4));
          if (rest.includes("--json")) {
            return { exitCode: 0, stdout: JSON.stringify({ days: daysOut, totalCostUsd: total, rates: RATES }, null, 2) };
          }
          if (daysOut.length === 0) return { exitCode: 0, stdout: `No voice usage recorded in the last ${days} day(s).` };
          const lines = daysOut.map(
            (d) => `${d.day}  $${d.cost.toFixed(4)}  (${d.responses} responses \u00b7 audio ${d.audioIn}/${d.audioOut} \u00b7 text ${d.textIn}/${d.textOut} \u00b7 cached ${d.cached})`,
          );
          return {
            exitCode: 0,
            stdout: `Voice usage, last ${days} day(s) \u2014 estimated at gpt-realtime rates:\n${lines.join("\n")}\nTotal: ~$${total.toFixed(4)}  (tokens in/out per line; authoritative numbers: platform.openai.com/usage)`,
          };
        }
        return { exitCode: 1, stderr: `Unknown command: ${command}\n\n${help}` };
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  bb.rpc.register(rpcContract, {
    runTool: input => liveRuntime.runTool(input),
    beginClientEffect: input => liveRuntime.beginClientEffect(input),
    finishClientEffect: input => liveRuntime.finishClientEffect(input),
    nextUpdateBatch: input => liveRuntime.nextUpdateBatch(input),
    closeOffer: input => liveRuntime.closeOffer(input),
    reportDrain: input => liveRuntime.reportDrain(input),
    finishUserExchange: input => liveRuntime.finishUserExchange(input),
    callStartContext: input => liveRuntime.callStartContext(input),
    listLiveSubscriptions: input => liveRuntime.listLiveSubscriptions(input),
    listLiveTasks: input => liveRuntime.listLiveTasks(input),
    async listWorkerProviders({hostId}) { return loadWorkerCatalog(bb,hostId); },
    async getWorkerSettings() { return readNamedWorkerSettings(bb); },
    async setWorkerSettings({settings,hostId}) {
      const validated = await validateNamedWorkerSettings(bb, settings, hostId);
      await bb.storage.kv.set(NAMED_WORKER_PROFILE_KEY,validated);
      bb.realtime.publish("worker-profiles-changed",{});
      return validated;
    },
    async claimCall({ nonce, newConversation = false, conversationId, transferFromNonce, threadId = null, projectId = null }) {
      if (transferFromNonce) {
        if (currentCall().nonce !== transferFromNonce) throw new Error("The call changed before you could switch. Check its current device and try again.");
        if (newConversation || conversationId) throw new Error("A device switch must keep the active conversation.");
        conversationId = conversations.listConversations(100).find(conversation => conversation.currentCallNonce === transferFromNonce)?.id;
        if (!conversationId) throw new Error("The active voice conversation could not be found.");
      }
      const selected = conversationId ? voiceSessions.get(conversationId).session : null;
      if (selected && currentCall().nonce && !transferFromNonce) throw new Error("End the current call before continuing another session.");
      let selectedId = selected?.legacy ? conversations.createConversation().id : selected?.id;
      if (selected?.legacy && selectedId) for (const callId of selected.callIds) voiceSessions.link(callId, selectedId);
      const previous = currentCall();
      if (previous.nonce) forceStopCall(previous.nonce, !!transferFromNonce);
      db.prepare("UPDATE voice_call_control SET sequence = sequence + 1, nonce = ? WHERE slot = 1").run(nonce);
      const { sequence } = currentCall();
      bb.realtime.publish("voice-call", { nonce, sequence });
      const started = conversations.startCall({ nonce, sequence, view: { threadId, projectId }, newConversation: selectedId ? false : newConversation, conversationId: selectedId });
      voiceSessions.link(nonce, started.conversationId);
      return { sequence, conversationId: started.conversationId, voiceSessionId: started.conversationId, resumed: started.resumed };
    },
    async reconnectCall({ nonce, previousNonce }) {
      const current = currentCall();
      // Retry the same claim after a lost RPC reply, but never replace another owner.
      if (current.nonce !== previousNonce && current.nonce !== nonce) return null;
      const link = db.prepare("SELECT conversation_id FROM voice_conversation_calls WHERE call_id = ?")
        .get(current.nonce) as { conversation_id: string } | undefined;
      if (!link) return null;
      if (current.nonce !== nonce) {
        forceStopCall(previousNonce, true);
        db.prepare("UPDATE voice_call_control SET sequence = sequence + 1, nonce = ? WHERE slot = 1").run(nonce);
        const { sequence } = currentCall();
        conversations.startCall({ nonce, sequence, view: {threadId:null,projectId:null}, newConversation: false, conversationId: link.conversation_id });
        voiceSessions.link(nonce, link.conversation_id);
        bb.realtime.publish("voice-call", { nonce, sequence });
      }
      return { sequence: currentCall().sequence, conversationId: link.conversation_id, voiceSessionId: link.conversation_id, resumed: true };
    },
    async createCall({ sdp, threadId, projectId, onNewThreadScreen, nonce, mobile = false }) {
      if (currentCall().nonce !== nonce) throw new Error("Voice call was stopped or replaced.");
      const key = await apiKey();
      const { model, voice } = await readConfig();
      // The model can only choose a profile it was shown; unreadable settings leave the free-form schema.
      const profiles = await readNamedWorkerSettings(bb).then(s => ({ profiles: s.profiles.map(p => ({ name: p.name, instructions: p.instructions })), defaultProfile: s.defaultProfile }))
        .catch(error => { bb.log.warn(`Worker profiles unavailable for the call schema: ${String(error)}`); return {}; });

      const session = {
        type: "realtime",
        model,
        instructions: prompts.read("aide"),
        audio: {
          input: {
            noise_reduction: { type: "near_field" },
            transcription: { model: "gpt-realtime-whisper", delay: "minimal" },
            // The client owns input commits and word-qualified interruption.
            turn_detection: null,
          },
          output: { voice },
        },
        tools: liveToolSchemas(profiles),
      };
      const form = new FormData();
      form.set("sdp", sdp);
      form.set("session", JSON.stringify(session));
      if (currentCall().nonce !== nonce) throw new Error("Voice call was stopped or replaced.");
      const response = await fetch(REALTIME_ENDPOINT, {
        signal: AbortSignal.timeout(12_000),
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      const text = await response.text();
      if (!response.ok) {
        bb.log.error(`OpenAI realtime call failed: ${response.status} ${text.slice(0, 500)}`);
        throw new Error(`OpenAI realtime call failed: ${response.status} ${response.statusText}`);
      }
      if (currentCall().nonce !== nonce) throw new Error("Voice call was stopped or replaced.");
      return { sdp: text };
    },
    async getPrompt(input) {
      const role=input?.role ?? "aide";
      return {content:prompts.read(role),defaultContent:promptDefault(role),versions:prompts.versions(role),proposal:null};
    },
    async setPrompt({role="aide",content,note}) {
      if (role === "coordinator" || role === "live") throw new Error("Previous prompts are read only.");
      prompts.save(role,content,note);
      bb.realtime.publish("prompt-changed",{role});
      return {ok:true as const};
    },
    async getConfig() {
      return await readConfig();
    },
    async setConfig(patch) {
      const next = await writeConfig(patch);
      bb.log.info(`voice config updated: ${JSON.stringify(patch)}`);
      // Every open window refetches, so the settings sections and the nav-panel
      // quick-switch stay in sync across windows.
      bb.realtime.publish("config-changed", {});
      return next;
    },
    async clearApiKey() {
      // null (not "") actually removes the secret, so the settings field shows
      // "not set" again rather than an empty-but-present value.
      await bb.sdk.plugins.updateSettings({ pluginId: bb.pluginId, values: { openaiApiKey: null } });
      bb.log.info("OpenAI API key cleared");
      bb.realtime.publish("config-changed", {});
      return { ok: true as const };
    },
    async getCredentialStatus() {
      const { openaiApiKey } = await settings.get();
      const { credentialPreference: preference } = await readConfig();
      const hasApiKey = !!openaiApiKey;
      const envKeyPresent = !!process.env.OPENAI_API_KEY;
      const subscriptionAvailable = !!(await codexToken());
      const keySource = hasApiKey ? ("apiKey" as const) : envKeyPresent ? ("env" as const) : null;
      // Mirror apiKey() so the badge shows what a session will actually use.
      const effective =
        preference === "subscription"
          ? subscriptionAvailable
            ? ("subscription" as const)
            : (keySource ?? ("none" as const))
          : keySource ?? (subscriptionAvailable ? ("subscription" as const) : ("none" as const));
      return { effective, preference, hasApiKey, envKeyPresent, subscriptionAvailable };
    },
    async getLiveTranscript() {
      return liveTranscript.callNonce === currentCall().nonce ? liveTranscript : EMPTY_TRANSCRIPT;
    },
    async publishTranscript(snapshot) {
      if (!snapshot.callNonce || snapshot.callNonce !== currentCall().nonce) return { ok: false };
      if (liveTranscript.callNonce === snapshot.callNonce && snapshot.revision <= liveTranscript.revision) return { ok: false };
      liveTranscript = snapshot;
      bb.realtime.publish("voice-transcript", snapshot);
      return { ok: true };
    },
    async logEvent({ sessionId, kind, payload }) {
      const { ts, id } = appendEvent(sessionId, kind, payload);
      // Both views describe this exact persisted event, including client/session
      // and tool call identity. Client-handled tools must be visible here too.
      const entry = sessionEventLog({ id, ts, sessionId, kind, payload });
      bb.log[entry.level](entry.message);
      bb.realtime.publish("aide-log", { sessionId });
      return { ok: true as const };
    },
    async publishPresence({ nonce, phase, startedAt, client, realm }) {
      if (phase !== "idle" && currentCall().nonce !== nonce) {
        bb.realtime.publish("voice-command", { nonce, action: "stop" });
        return { ok: true as const };
      }
      if (phase === "idle") {
                db.prepare("UPDATE voice_call_control SET nonce = NULL WHERE nonce = ?").run(nonce);
    conversations.endCall(nonce);
      }
      bb.realtime.publish("voice-presence", { nonce, phase, startedAt, client, realm });
      return { ok: true as const };
    },
    async requestPresence() {
      bb.realtime.publish("voice-presence-query", {});
      return { ok: true as const };
    },
    async sendVoiceCommand({ nonce, action, client, realm }) {
      bb.realtime.publish("voice-command", { nonce, action, client, realm });
      return { ok: true as const };
    },
    async forceStop({ nonce }) {
      forceStopCall(nonce);
      return { ok: true as const };
    },
    async listVoiceSessions(input) { return voiceSessions.list(input?.before); },
    async getVoiceSession({sessionId}) {
      const detail = voiceSessions.get(sessionId);
      return { ...detail, work: readConversationWork(db, detail.session.id) };
    },
    async recordUsage({ model, sessionId, usage }) {
      const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
      const inDetails = (usage.input_token_details ?? {}) as Record<string, unknown>;
      const outDetails = (usage.output_token_details ?? {}) as Record<string, unknown>;
      const cachedDetails = (inDetails.cached_tokens_details ?? {}) as Record<string, unknown>;
      const { model: configuredModel } = await readConfig();
      db.prepare(
        `INSERT INTO usage_events (ts, model, session_id, input_text, input_audio, cached_text, cached_audio, output_text, output_audio)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        Date.now(),
        model ?? configuredModel,
        sessionId,
        num(inDetails.text_tokens),
        num(inDetails.audio_tokens),
        num(cachedDetails.text_tokens),
        num(cachedDetails.audio_tokens),
        num(outDetails.text_tokens),
        num(outDetails.audio_tokens),
      );
      return { ok: true as const };
    },
  });
}
