import { useState } from "react";
import { HostIcon } from "../lib/host-icon";
import { appearanceHueStep, appearanceIcon } from "../lib/project-hue";
import {
  PROJECT_COLORS,
  PROJECT_ICONS,
  type ProjectAppearance,
} from "../lib/project-tree-schema";

export type AppearancePatch = {
  icon?: (typeof PROJECT_ICONS)[number] | null;
  color?: (typeof PROJECT_COLORS)[number] | null;
};

const cell =
  "flex size-7 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-pressed:bg-accent aria-pressed:ring-1 aria-pressed:ring-border";

/**
 * Inline icon and color picker that replaces an Initiative row, like Rename.
 * Each choice saves at once; "Automatic" color and "Reset" go back to the
 * default look (Target, hue from the name). Escape or Done closes it.
 */
export function ProjectAppearanceEditor({
  name,
  appearance,
  onChange,
  onClose,
}: {
  name: string;
  appearance: ProjectAppearance | undefined;
  onChange: (patch: AppearancePatch) => Promise<void>;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown at once after a save; the tree refetch catches up behind it.
  const [local, setLocal] = useState<ProjectAppearance>({
    icon: appearance?.icon ?? null,
    color: appearance?.color ?? null,
  });
  const { icon, color } = local;
  const save = async (patch: AppearancePatch) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onChange(patch);
      setLocal((current) => ({ ...current, ...patch }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      role="group"
      aria-label={`Icon and color for ${name}`}
      className="flex min-w-0 flex-1 flex-col gap-2 px-3 py-2"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <span
          aria-hidden="true"
          data-project-hue={appearanceHueStep(name, color)}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-current/10"
        >
          <HostIcon name={appearanceIcon(icon)} fallback="Folder" className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </div>
      <div role="group" aria-label="Color" className="flex flex-wrap gap-0.5">
        <button
          type="button"
          aria-label="Automatic color"
          title="Automatic (from the name)"
          aria-pressed={color === null}
          disabled={saving}
          onClick={() => save({ color: null })}
          className={cell}
        >
          <span
            aria-hidden="true"
            data-project-hue={appearanceHueStep(name, null)}
            className="size-3.5 rounded-full border-2 border-current"
          />
        </button>
        {PROJECT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            title={c}
            aria-pressed={color === c}
            disabled={saving}
            onClick={() => save({ color: c })}
            className={cell}
          >
            <span
              aria-hidden="true"
              data-project-hue={appearanceHueStep(name, c)}
              className="size-3.5 rounded-full bg-current"
            />
          </button>
        ))}
      </div>
      <div role="group" aria-label="Icon" className="grid grid-cols-8 gap-0.5">
        {PROJECT_ICONS.map((i) => (
          <button
            key={i}
            type="button"
            aria-label={i}
            title={i}
            aria-pressed={(icon ?? "Target") === i}
            disabled={saving}
            onClick={() => save({ icon: i === "Target" ? null : i })}
            className={cell}
          >
            <HostIcon name={i} fallback="Folder" className="size-4" />
          </button>
        ))}
      </div>
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          disabled={saving || (icon === null && color === null)}
          onClick={() => save({ icon: null, color: null })}
          className="rounded-md px-2 py-1.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Reset
        </button>
        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="rounded-md px-2 py-1.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Done
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
