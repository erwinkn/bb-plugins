import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { usePortalScopeProps } from "../lib/portal-scope";
import {
  formatWakeTime,
  parseUntil,
  resolvePreset,
  toDateTimeLocal,
  type SnoozePreset,
} from "../lib/snooze-presets";

export type SnoozePickerMode = "presets" | "custom";

const buttonClass =
  "flex w-full cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground";

/** Preset rows with their resolved wake time, shared by the popover and the menu. */
export function snoozeChoices(presets: readonly SnoozePreset[], now: number) {
  return presets.map((preset) => {
    const until = resolvePreset(preset, now);
    return { ...preset, until, hint: formatWakeTime(until, now) };
  });
}

/**
 * The body of the snooze popover: presets, then a date/time form. Lives
 * inside a `Popover.Root` owned by the row so the anchor is the row itself.
 */
export function SnoozePopoverContent({
  title,
  now,
  mode,
  presets,
  onSnooze,
  onClose,
}: {
  title: string;
  now: number;
  mode: SnoozePickerMode;
  presets: readonly SnoozePreset[];
  onSnooze: (until: number) => void;
  onClose: () => void;
}) {
  const scope = usePortalScopeProps();
  const [custom, setCustom] = useState(mode === "custom");
  const [value, setValue] = useState(() =>
    toDateTimeLocal(
      resolvePreset(
        presets[0] ?? {
          id: "later",
          label: "Later",
          rule: { type: "duration", minutes: 60 },
        },
        now,
      ),
    ),
  );
  const [invalid, setInvalid] = useState(false);
  const submitCustom = () => {
    const until = parseUntil(value, Date.now(), []);
    if (until === null) {
      setInvalid(true);
      return;
    }
    onSnooze(until);
    onClose();
  };
  return (
    <Popover.Portal>
      <Popover.Content
        {...scope}
        aria-label={`Snooze ${title}`}
        align="end"
        sideOffset={4}
        collisionPadding={8}
        onOpenAutoFocus={(event) => {
          // The date field is the point of the custom mode; presets get the
          // first button through Radix's default focus.
          if (custom) {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)
              ?.querySelector<HTMLInputElement>("input")
              ?.focus();
          }
        }}
        className="z-50 w-60 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      >
        {!custom ? (
          <ul aria-label="Snooze until" className="m-0 list-none p-0">
            {snoozeChoices(presets, now).map((choice) => (
              <li key={choice.id}>
                <button
                  type="button"
                  data-snooze-preset={choice.id}
                  onClick={() => {
                    onSnooze(choice.until);
                    onClose();
                  }}
                  className={buttonClass}
                >
                  <span className="min-w-0 flex-1">{choice.label}</span>
                  <span className="shrink-0 text-xs tabular-nums text-[var(--subtle-foreground)]">
                    {choice.hint}
                  </span>
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                data-snooze-preset="custom"
                onClick={() => setCustom(true)}
                className={buttonClass}
              >
                Custom date and time…
              </button>
            </li>
          </ul>
        ) : (
          <form
            aria-label="Snooze until a date and time"
            className="flex flex-col gap-2 p-1"
            onSubmit={(event) => {
              event.preventDefault();
              submitCustom();
            }}
          >
            <input
              type="datetime-local"
              aria-label="Wake time"
              aria-invalid={invalid || undefined}
              value={value}
              min={toDateTimeLocal(now)}
              onChange={(event) => {
                setInvalid(false);
                setValue(event.target.value);
              }}
              className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {invalid && (
              <p role="alert" className="text-xs text-destructive">
                Pick a time in the future.
              </p>
            )}
            <div className="flex justify-end gap-1">
              {mode !== "custom" && (
                <button
                  type="button"
                  onClick={() => setCustom(false)}
                  className="rounded-md px-2 py-1 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Back
                </button>
              )}
              <button
                type="submit"
                className="rounded-md bg-primary px-2 py-1 text-sm text-primary-foreground hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
              >
                Snooze
              </button>
            </div>
          </form>
        )}
      </Popover.Content>
    </Popover.Portal>
  );
}
