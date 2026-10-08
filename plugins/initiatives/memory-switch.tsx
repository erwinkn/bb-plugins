import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { MemoryMode } from "./lib/memory/store";
import { WRITE_SLOW_MESSAGE } from "./lib/write-timeout";
import { useWrite } from "./write-status";

/**
 * D447: the Initiative's one memory setting, for its coordinator and later its discussion threads
 * (D446). The tree builds in every mode, so a switch is instant and applies from the next turn.
 */
export const MEMORY_MODES_TEXT: Record<MemoryMode, { label: string; line: string }> = {
  regular: { label: "Regular", line: "One long chat, compacted once it gets large." },
  hybrid: { label: "Hybrid", line: "Compacts sooner; what it drops stays one zoom away in the summary tree." },
  optchat: { label: "OptChat", line: "A fresh turn per message over the summary view. Not available yet: runs as hybrid." },
};
const MODES = Object.keys(MEMORY_MODES_TEXT) as MemoryMode[];

/**
 * A three-way segmented control. explain "selected" adds the chosen mode's line (the dashboard
 * header); "all" lists every mode's line (the thread header's popover and the Context tab).
 */
export function MemorySwitch({
  mode,
  choose,
  explain,
  label = true,
  session = null,
}: {
  mode: MemoryMode;
  /** W244: the memory status's session note, when the coordinator may lack its memory tools. */
  session?: string | null;
  choose: (mode: MemoryMode) => Promise<unknown>;
  explain: "selected" | "all";
  /** False under a heading that already says Memory. */
  label?: boolean;
}) {
  const labelId = useId();
  const [pending, setPending] = useState<MemoryMode | null>(null);
  const write = useWrite();
  // The chosen mode shows while its save runs; a failed or unconfirmed one shows the saved mode again.
  const shown = write.busy ? (pending ?? mode) : mode;
  // W244: a radio group's keys. Tab reaches only the selected mode; the arrows (Home, End)
  // select a neighbour, which saves it like a click.
  const segments = useRef<(HTMLButtonElement | null)[]>([]);
  const saved = useRef(mode);
  saved.current = mode;
  const pick = async (next: MemoryMode) => {
    if (next === mode || write.busy) return;
    setPending(next);
    const done = await write.run(() => choose(next));
    // W248: a save that failed shows the saved mode again, and focus goes back with it, so the
    // arrows move on from the mode shown as selected.
    const focused = segments.current.findIndex((el) => el !== null && el === document.activeElement);
    if (!done.ok && focused !== -1) segments.current[MODES.indexOf(saved.current)]?.focus();
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
    <div className="memory-switch">
      <div className="memory-switch-row">
        {label ? <span className="memory-switch-label" id={labelId}>Memory</span> : null}
        <div className="memory-switch-segments" role="radiogroup" {...(label ? { "aria-labelledby": labelId } : { "aria-label": "Memory" })} aria-busy={write.busy} onKeyDown={onKeyDown}>
          {MODES.map((m, k) => (
            <button
              key={m}
              ref={(el) => void (segments.current[k] = el)}
              type="button"
              role="radio"
              aria-checked={m === shown}
              tabIndex={m === shown ? 0 : -1}
              title={MEMORY_MODES_TEXT[m].line}
              className={`memory-switch-segment${m === shown ? " memory-switch-segment--on" : ""}`}
              // aria-disabled, not disabled: a save under way keeps the keyboard's focus in place.
              aria-disabled={write.busy}
              onClick={() => void pick(m)}
            >
              {MEMORY_MODES_TEXT[m].label}
            </button>
          ))}
        </div>
      </div>
      {explain === "selected" ? (
        <p className="memory-switch-line">{MEMORY_MODES_TEXT[shown].line}</p>
      ) : (
        <dl className="memory-switch-lines">
          {MODES.map((m) => (
            <div key={m} className={m === shown ? "memory-switch-current" : undefined}>
              <dt>{MEMORY_MODES_TEXT[m].label}</dt>
              <dd>{MEMORY_MODES_TEXT[m].line}</dd>
            </div>
          ))}
        </dl>
      )}
      {session ? <p role="status" className="memory-switch-line memory-switch-session">{session}</p> : null}
      {write.slow ? <p role="status" className="memory-switch-line">{WRITE_SLOW_MESSAGE}</p> : null}
      {write.error ? <p role="alert" className="memory-switch-error">{write.error}</p> : null}
    </div>
  );
}
