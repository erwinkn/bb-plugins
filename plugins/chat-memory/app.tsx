import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { definePluginApp, useRealtime, useRpc, type PluginThreadHeaderActionProps, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { chatMemoryContract } from "./lib/contract";
import type { MemoryStatus } from "./lib/memory";
import type { MemoryMode } from "./lib/store";
import "./app.css";

const CHANGED_CHANNEL = "chat-memory-changed";
const PANEL = "memory";
type Api = ReturnType<typeof useRpc<typeof chatMemoryContract>>;
type Configure = Parameters<Api["call"]>[1] & { threadId: string };

export const MEMORY_MODES_TEXT: Record<MemoryMode, { label: string; line: string }> = {
  regular: { label: "Regular", line: "One long session, compacted once it gets large." },
  hybrid: { label: "Hybrid", line: "Compacts sooner; what it drops stays one zoom away in the summary tree." },
  optchat: { label: "OptChat", line: "A fresh session per message over the summary view (Claude Code only)." },
};
const MODES = Object.keys(MEMORY_MODES_TEXT) as MemoryMode[];
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
const kilo = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** The last status read per thread, so a pill and a panel on the same thread show it at once. */
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

/**
 * The three modes as a radio group (W244): Tab reaches the selected mode, the arrows (Home, End)
 * select a neighbour, which saves it like a click. The chosen mode shows while its save runs; a
 * refused one shows the saved mode again, with the reason.
 */
function MemorySwitch({ mode, choose }: { mode: MemoryMode; choose: (mode: MemoryMode) => Promise<unknown> }) {
  const [pending, setPending] = useState<MemoryMode | null>(null);
  const write = useWrite();
  const shown = write.busy ? (pending ?? mode) : mode;
  const segments = useRef<(HTMLButtonElement | null)[]>([]);
  const saved = useRef(mode);
  saved.current = mode;
  const pick = async (next: MemoryMode) => {
    if (next === mode || write.busy) return;
    setPending(next);
    const ok = await write.run(() => choose(next));
    const focused = segments.current.findIndex((el) => el !== null && el === document.activeElement);
    if (!ok && focused !== -1) segments.current[MODES.indexOf(saved.current)]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const at = MODES.indexOf(shown);
    const to = e.key === "Home" ? 0 : e.key === "End" ? MODES.length - 1 : step === undefined ? null : (at + step + MODES.length) % MODES.length;
    if (to === null) return;
    e.preventDefault();
    if (write.busy) return;
    segments.current[to]?.focus();
    void pick(MODES[to]!);
  };
  return (
    <div className="cm-switch">
      <div className="cm-segments" role="radiogroup" aria-label="Memory mode" aria-busy={write.busy} onKeyDown={onKeyDown}>
        {MODES.map((m, k) => (
          <button
            key={m}
            ref={(el) => void (segments.current[k] = el)}
            type="button"
            role="radio"
            aria-checked={m === shown}
            tabIndex={m === shown ? 0 : -1}
            title={MEMORY_MODES_TEXT[m].line}
            className={`cm-segment${m === shown ? " cm-segment--on" : ""}`}
            // aria-disabled, not disabled: a save under way keeps the keyboard's focus in place.
            aria-disabled={write.busy}
            onClick={() => void pick(m)}
          >
            {MEMORY_MODES_TEXT[m].label}
          </button>
        ))}
      </div>
      <dl className="cm-modes">
        {MODES.map((m) => (
          <div key={m} className={m === shown ? "cm-mode--on" : undefined}>
            <dt>{MEMORY_MODES_TEXT[m].label}</dt>
            <dd>{MEMORY_MODES_TEXT[m].line}</dd>
          </div>
        ))}
      </dl>
      {write.error ? <p role="alert" className="cm-error">{write.error}</p> : null}
    </div>
  );
}

const treeState = (t: MemoryStatus["tree"]) =>
  t.state === "unavailable" ? `summarizer unavailable: ${t.detail}`
  : t.state === "backoff" ? `rate-limited; retrying${t.until ? ` at ${new Date(t.until).toLocaleTimeString()}` : ""}`
  : t.state === "building" ? "building"
  : "up to date";

/** D431, D447: a memory's mode, problems, threads, log, tree, cost and compaction limit. */
function MemoryDetails({ status: m, configure }: { status: MemoryStatus; configure: (patch: Omit<Configure, "threadId">) => Promise<unknown> }) {
  const [limit, setLimit] = useState("");
  const write = useWrite();
  const tokens = Number(limit.replace(/k$/i, "")) * (/k$/i.test(limit) ? 1000 : 1);
  const t = m.tree;
  const own = m.scope.owner === "chat-memory";
  const threads = m.threads;
  return (
    <div className="cm-details">
      <MemorySwitch mode={m.mode} choose={(mode) => configure({ mode })} />
      {m.problems.length ? (
        <ul className="cm-problems" role="status">
          {m.problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      ) : null}
      <div className="cm-grid">
        <span>Shared by</span>
        <span>
          {own ? "this thread" : `${m.scope.owner === "initiatives" ? "the Initiative's" : `${m.scope.owner}'s`} ${threads.length} thread${threads.length === 1 ? "" : "s"}`}
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
        <span>{m.compactTokens ? `past ${kilo(m.compactTokens)} tokens` : "off"}{m.mode === "optchat" ? " (OptChat sessions never grow)" : m.compactTokensOverride === null ? ` · the ${m.mode} default` : " · this memory's own limit"}</span>
      </div>
      <div className="cm-actions">
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
        {own ? (
          <button type="button" disabled={write.busy} onClick={() => void write.run(() => configure({ enabled: false }))}>Turn memory off</button>
        ) : null}
      </div>
      {write.error ? <p role="alert" className="cm-error">{write.error}</p> : null}
    </div>
  );
}

/** The thread header's memory pill and its popover (in the top layer, so the header never clips it), for threads with memory. */
export function MemoryPill({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { status, configure, reload } = useMemory(threadId);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<{ top: number; right: number } | null>(null);
  if (!status) return null;
  const label = MEMORY_MODES_TEXT[status.mode].label;
  const warn = status.problems.length > 0;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`cm-pill${warn ? " cm-pill--warn" : ""}`}
        popoverTarget={id}
        aria-label={`Memory: ${label}${warn ? ", needs attention" : ""}. Change it`}
        title="Memory mode"
      >
        {isCompactViewport ? label : `Memory · ${label}`}
        {warn ? <span aria-hidden="true"> !</span> : null}
      </button>
      <div
        id={id}
        popover="auto"
        className="cm-popover"
        style={place ? { top: place.top, right: place.right } : undefined}
        onBeforeToggle={(e) => {
          if (e.newState !== "open" || !button.current) return;
          void reload();
          const r = button.current.getBoundingClientRect();
          setPlace({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
        }}
      >
        <MemoryDetails status={status} configure={configure} />
        <p className="cm-note">The summary tree builds in every mode, so a switch is instant and applies from the next turn.</p>
      </div>
    </>
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
          <p className="cm-muted">Every message is logged and summarized by GPT-6 Luna into a tree the agent reads and zooms. The tree builds in every mode, so a switch applies from the next turn.</p>
          <MemoryDetails status={status} configure={configure} />
        </>
      ) : (
        <>
          <p className="cm-muted">
            This thread has no chat memory. With memory, every message is logged and summarized by GPT-6 Luna into a tree the agent reads and zooms, in Regular, Hybrid or OptChat mode. The agent gets its memory tools with its next session.
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
  app.slots.experimental_threadHeaderAction({ id: "chat-memory", title: "Memory", component: MemoryPill });
  app.slots.threadPanelAction({ id: PANEL, title: "Memory", icon: "Brain", component: MemoryPanel });
});
