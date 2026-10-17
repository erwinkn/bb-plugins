import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRpc, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { chatMemoryContract } from "./lib/contract";
import type { MemoryStatus } from "./lib/memory";
import type { MemoryMode } from "./lib/store";
import "./app.css";

const CHANGED_CHANNEL = "chat-memory-changed";
const PANEL = "memory";
type Api = ReturnType<typeof useRpc<typeof chatMemoryContract>>;
type Configure = Parameters<Api["call"]>[1] & { threadId: string };

/** R3: the mode follows the role, so the panel only says which one this memory has. */
export const MEMORY_MODES_TEXT: Record<MemoryMode, { label: string; line: string }> = {
  regular: { label: "Regular", line: "One long session, compacted once it gets large." },
  optchat: { label: "OptChat", line: "A fresh session per message over the summary view (Claude Code only). Every Adventure coordinator uses it." },
};
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
const kilo = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** The last status read per thread, so a remount shows it at once. */
const seen = new Map<string, MemoryStatus | null>();

/** A thread's memory, read at mount and again whenever any memory changes (realtime). */
function useMemory(threadId: string) {
  const api = useRpc<typeof chatMemoryContract>();
  const [status, setStatus] = useState<MemoryStatus | null | undefined>(seen.get(threadId));
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const id = ++latest.current;
    try {
      const next = await api.call("status", { threadId });
      seen.set(threadId, next);
      if (id === latest.current) {
        setStatus(next);
        setError(null);
      }
    } catch (e) {
      if (id === latest.current) setError(text(e));
    }
  }, [api, threadId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useRealtime(CHANGED_CHANNEL, () => void reload());
  const configure = useCallback(
    async (patch: Omit<Configure, "threadId">) => {
      const next = await api.call("configure", { threadId, ...patch });
      seen.set(threadId, next);
      setStatus(next);
      return next;
    },
    [api, threadId],
  );
  return { status, error, reload, configure };
}

/** One user write's state: busy while it runs, its error (a refusal says why) until the next. */
function useWrite() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (e) {
      setError(text(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

const treeState = (t: MemoryStatus["tree"]) =>
  t.state === "unavailable" ? `summarizer unavailable: ${t.detail}`
  : t.state === "backoff" ? `rate-limited; retrying${t.until ? ` at ${new Date(t.until).toLocaleTimeString()}` : ""}`
  : t.state === "building" ? "building"
  : "up to date";

/** D431, D447: a memory's mode (fixed by its role), problems, threads, log, tree, cost and compaction limit. */
function MemoryDetails({ status: m, configure }: { status: MemoryStatus; configure: (patch: Omit<Configure, "threadId">) => Promise<unknown> }) {
  const [limit, setLimit] = useState("");
  const write = useWrite();
  const tokens = Number(limit.replace(/k$/i, "")) * (/k$/i.test(limit) ? 1000 : 1);
  const t = m.tree;
  const own = m.scope.owner === "chat-memory";
  const threads = m.threads;
  return (
    <div className="cm-details">
      <p className="cm-muted"><strong>{MEMORY_MODES_TEXT[m.mode].label}</strong>: {MEMORY_MODES_TEXT[m.mode].line}</p>
      {m.problems.length ? (
        <ul className="cm-problems" role="status">
          {m.problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      ) : null}
      <div className="cm-grid">
        <span>Shared by</span>
        <span>
          {own ? "this thread" : `${m.scope.owner === "initiatives" ? "the Adventure's" : `${m.scope.owner}'s`} ${threads.length} thread${threads.length === 1 ? "" : "s"}`}
          {threads.length > 1 || !own ? `: ${threads.map((x) => x.title ?? x.threadId).join(", ")}` : ""}
        </span>
        <span>Log</span>
        <span>{m.log.messages.toLocaleString()} messages · {kilo(m.log.bytes)}B</span>
        <span>Tree</span>
        <span>
          {t.nodes.toLocaleString()} of {t.total.toLocaleString()} lines ({t.total ? Math.floor((100 * Math.min(t.nodes, t.total)) / t.total) : 100}%){t.fallbacks ? ` · ${t.fallbacks} cut after failures` : ""} · {treeState(t)}
        </span>
        <span>Views</span>
        <span>chat {kilo(t.viewBytes)}B · memory {kilo(t.memoryViewBytes)}B</span>
        {m.cost.calls ? (
          <>
            <span>Cost</span>
            <span>
              ${m.cost.usd.toFixed(2)} at list price · {m.cost.calls.toLocaleString()} calls · {kilo(m.cost.inputTokens)} in ({m.cost.inputTokens ? Math.round((100 * m.cost.cachedTokens) / m.cost.inputTokens) : 0}% cached), {kilo(m.cost.outputTokens)} out
            </span>
          </>
        ) : null}
        <span>Compaction</span>
        <span>{m.compactTokens ? `past ${kilo(m.compactTokens)} tokens` : "off"}{m.mode === "optchat" ? " (OptChat sessions never grow)" : m.compactTokensOverride === null ? " · the default" : " · this memory's own limit"}</span>
      </div>
      <div className="cm-actions">
        {m.mode === "regular" ? (
          <>
            <label className="cm-field">
              Compaction limit (tokens)
              <input value={limit} placeholder={kilo(m.compactTokens)} onChange={(e) => setLimit(e.target.value.trim())} inputMode="numeric" />
            </label>
            <button type="button" disabled={!limit || !Number.isInteger(tokens) || tokens < 0 || write.busy} onClick={() => void write.run(async () => { await configure({ compactTokens: tokens }); setLimit(""); })}>
              Save limit
            </button>
            {m.compactTokensOverride !== null ? (
              <button type="button" disabled={write.busy} onClick={() => void write.run(() => configure({ compactTokens: null }))}>Use the default</button>
            ) : null}
          </>
        ) : null}
        {own ? (
          <button type="button" disabled={write.busy} onClick={() => void write.run(() => configure({ enabled: false }))}>Turn memory off</button>
        ) : null}
      </div>
      {write.error ? <p role="alert" className="cm-error">{write.error}</p> : null}
    </div>
  );
}

/** The thread's Memory panel: its memory, or a way to turn one on. */
export function MemoryPanel({ threadId }: PluginThreadPanelProps) {
  const { status, error, configure } = useMemory(threadId);
  const write = useWrite();
  if (status === undefined) return <p className="cm-muted">{error ?? "Loading…"}</p>;
  return (
    <section className="cm-panel" aria-label="Memory">
      <h2>Memory</h2>
      {status ? (
        <>
          <p className="cm-muted">Every message is logged and summarized by GPT-6 Luna into a tree the agent reads and zooms.</p>
          <MemoryDetails status={status} configure={configure} />
        </>
      ) : (
        <>
          <p className="cm-muted">
            This thread has no chat memory. With memory, every message is logged and summarized by GPT-6 Luna into a tree the agent reads and zooms, in Regular mode. The agent gets its memory tools with its next session.
          </p>
          <div className="cm-actions">
            <button type="button" disabled={write.busy} onClick={() => void write.run(() => configure({}))}>Turn memory on</button>
          </div>
          {write.error ? <p role="alert" className="cm-error">{write.error}</p> : null}
        </>
      )}
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({ id: PANEL, title: "Memory", icon: "Brain", component: MemoryPanel });
});
