import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { snoozeContract } from "../lib/snooze-contract";
import {
  DEFAULT_SNOOZE_PRESETS,
  MAX_PRESETS,
  describeRule,
  formatWakeTime,
  normalizePresets,
  resolveRule,
  slugifyPresetId,
  snoozePresetsDocSchema,
  type SnoozePreset,
  type SnoozeRule,
} from "../lib/snooze-presets";
import { useSnoozePresets } from "../lib/use-snooze";

const fieldClass =
  "min-w-0 rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const buttonClass =
  "rounded-md px-2 py-1 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** A row in the editor: strings while typing, validated on save. */
interface Draft {
  key: number;
  id: string;
  label: string;
  type: SnoozeRule["type"];
  minutes: string;
  days: string;
  time: string;
}
let nextKey = 0;
const toDraft = (preset: SnoozePreset): Draft => ({
  key: nextKey++,
  id: preset.id,
  label: preset.label,
  type: preset.rule.type,
  minutes: String(preset.rule.type === "duration" ? preset.rule.minutes : 60),
  days: String(preset.rule.type === "time" ? preset.rule.days : 1),
  time:
    preset.rule.type === "time"
      ? `${String(preset.rule.hour).padStart(2, "0")}:${String(preset.rule.minute).padStart(2, "0")}`
      : "09:00",
});
const fromDraft = (draft: Draft): unknown => {
  const [hour, minute] = draft.time.split(":").map(Number);
  return {
    id: draft.id,
    label: draft.label,
    rule:
      draft.type === "duration"
        ? { type: "duration", minutes: Number(draft.minutes) }
        : { type: "time", days: Number(draft.days), hour, minute },
  };
};
const blankDraft = (): Draft => ({
  key: nextKey++,
  id: "",
  label: "",
  type: "duration",
  minutes: "60",
  days: "1",
  time: "09:00",
});

/**
 * Settings section: the preset list shared by the row popover, the row menu,
 * and `bb sidebar snooze --until <name>`. Saved as one document.
 */
export function SnoozeSettings() {
  const rpc = useRpc<typeof snoozeContract>();
  const presets = useSnoozePresets();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [loadedRevision, setLoadedRevision] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Load the form from the server document once; later signals only replace
  // an untouched form so another client's save is not typed over.
  useEffect(() => {
    if (presets.status !== "ready") return;
    if (drafts !== null && loadedRevision === presets.doc.revision) return;
    if (drafts === null || !dirty) {
      setDrafts(presets.doc.presets.map(toDraft));
      setLoadedRevision(presets.doc.revision);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presets.status, presets.doc]);
  const [dirty, setDirty] = useState(false);
  const update = (key: number, patch: Partial<Draft>) => {
    setDirty(true);
    setSavedAt(null);
    setDrafts((current) =>
      (current ?? []).map((draft) =>
        draft.key === key ? { ...draft, ...patch } : draft,
      ),
    );
  };
  const move = (index: number, delta: number) => {
    setDirty(true);
    setDrafts((current) => {
      const list = [...(current ?? [])];
      const target = index + delta;
      if (target < 0 || target >= list.length) return list;
      [list[index], list[target]] = [list[target]!, list[index]!];
      return list;
    });
  };
  const now = Date.now();
  // Live validation gives the preview and the message before a save.
  let preview: SnoozePreset[] | null = null;
  let problem: string | null = null;
  try {
    preview = drafts ? normalizePresets(drafts.map(fromDraft)) : null;
  } catch (cause) {
    problem = cause instanceof Error ? cause.message : String(cause);
  }
  const save = async () => {
    if (!drafts) return;
    setSaving(true);
    setError(null);
    try {
      const next = snoozePresetsDocSchema.parse(
        await rpc.call("saveSnoozePresets", {
          presets: drafts.map(fromDraft),
        }),
      );
      setDrafts(next.presets.map(toDraft));
      setLoadedRevision(next.revision);
      setDirty(false);
      setSavedAt(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  if (presets.status === "error" && drafts === null)
    return (
      <p role="alert" className="text-sm text-destructive">
        Cannot load the snooze presets: {presets.error}
      </p>
    );
  if (!drafts) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <form
      aria-label="Snooze presets"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Presets offered by Snooze in a thread row's hover control and context
        menu. The name is what agents pass to{" "}
        <code>bb sidebar snooze --until &lt;name&gt;</code>. A delay counts
        from now; a clock time is local and lands the given number of days
        ahead (0 means today, or tomorrow once it has passed).
      </p>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {drafts.map((draft, index) => {
          const parsed = preview?.[index];
          return (
            <li
              key={draft.key}
              data-snooze-preset-row={index}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
            >
              <input
                aria-label={`Preset ${index + 1} label`}
                placeholder="Label"
                value={draft.label}
                onChange={(event) =>
                  update(draft.key, {
                    label: event.target.value,
                    // Keep the name in step until it was edited by hand.
                    ...(draft.id === slugifyPresetId(draft.label)
                      ? { id: slugifyPresetId(event.target.value) }
                      : {}),
                  })
                }
                className={`${fieldClass} w-32 flex-1`}
              />
              <input
                aria-label={`Preset ${index + 1} name`}
                placeholder="cli-name"
                value={draft.id}
                onChange={(event) => update(draft.key, { id: event.target.value })}
                className={`${fieldClass} w-28 font-mono`}
              />
              <select
                aria-label={`Preset ${index + 1} kind`}
                value={draft.type}
                onChange={(event) =>
                  update(draft.key, {
                    type: event.target.value as SnoozeRule["type"],
                  })
                }
                className={fieldClass}
              >
                <option value="duration">Delay</option>
                <option value="time">Clock time</option>
              </select>
              {draft.type === "duration" ? (
                <label className="flex items-center gap-1 text-sm">
                  <input
                    aria-label={`Preset ${index + 1} minutes`}
                    type="number"
                    min={1}
                    value={draft.minutes}
                    onChange={(event) =>
                      update(draft.key, { minutes: event.target.value })
                    }
                    className={`${fieldClass} w-20`}
                  />
                  minutes
                </label>
              ) : (
                <>
                  <label className="flex items-center gap-1 text-sm">
                    <input
                      aria-label={`Preset ${index + 1} days ahead`}
                      type="number"
                      min={0}
                      value={draft.days}
                      onChange={(event) =>
                        update(draft.key, { days: event.target.value })
                      }
                      className={`${fieldClass} w-16`}
                    />
                    days ahead at
                  </label>
                  <input
                    aria-label={`Preset ${index + 1} time`}
                    type="time"
                    value={draft.time}
                    onChange={(event) =>
                      update(draft.key, { time: event.target.value })
                    }
                    className={fieldClass}
                  />
                </>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {parsed
                  ? `${describeRule(parsed.rule)} · ${formatWakeTime(resolveRule(parsed.rule, now), now)}`
                  : ""}
              </span>
              <span className="flex gap-1">
                <button
                  type="button"
                  aria-label={`Move preset ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  className={buttonClass}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move preset ${index + 1} down`}
                  disabled={index === drafts.length - 1}
                  onClick={() => move(index, 1)}
                  className={buttonClass}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Remove preset ${index + 1}`}
                  onClick={() => {
                    setDirty(true);
                    setDrafts((current) =>
                      (current ?? []).filter((item) => item.key !== draft.key),
                    );
                  }}
                  className={buttonClass}
                >
                  Remove
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={drafts.length >= MAX_PRESETS}
          onClick={() => {
            setDirty(true);
            setDrafts((current) => [...(current ?? []), blankDraft()]);
          }}
          className={buttonClass}
        >
          Add preset
        </button>
        <button
          type="button"
          onClick={() => {
            setDirty(true);
            setDrafts(DEFAULT_SNOOZE_PRESETS.map(toDraft));
          }}
          className={buttonClass}
        >
          Reset to defaults
        </button>
        <button
          type="submit"
          disabled={saving || problem !== null || !dirty}
          className={`${buttonClass} bg-primary text-primary-foreground hover:opacity-90`}
        >
          {saving ? "Saving…" : "Save presets"}
        </button>
        {savedAt !== null && !dirty && (
          <span role="status" className="text-sm text-muted-foreground">
            Saved.
          </span>
        )}
      </div>
    </form>
  );
}
