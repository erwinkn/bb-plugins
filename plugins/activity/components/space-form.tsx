import { useEffect, useRef, useState } from "react";
import { SPACE_NAME_MAX } from "../lib/space-contract";
import type { SpaceEdit } from "./scope-menu";

const buttonClass =
  "rounded-md px-3 py-1.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

// One inline form under the heading for creating, renaming, and deleting a
// space. The caller performs the save so it can also update the selection.
export function SpaceForm({
  edit,
  spaceName,
  onSubmit,
  onClose,
}: {
  edit: SpaceEdit;
  /** The selected space's name for rename and delete. */
  spaceName?: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(edit === "rename" ? (spaceName ?? "") : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  // The menu that opened this form gives up its focus restoration; take focus
  // here so typing or confirming starts immediately.
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      (inputRef.current ?? submitRef.current)?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  const trimmed = name.trim();
  const label =
    edit === "create"
      ? "Save as space"
      : edit === "rename"
        ? "Rename space"
        : "Delete space";
  return (
    <form
      aria-label={label}
      className="mt-2 flex flex-wrap items-center gap-2 px-2"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !savingRef.current) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (savingRef.current || (edit !== "delete" && !trimmed)) return;
        savingRef.current = true;
        setSaving(true);
        setError(null);
        try {
          await onSubmit(trimmed);
          onClose();
        } catch (cause) {
          setError(
            cause instanceof Error ? cause.message : "Could not save the space.",
          );
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      }}
    >
      {edit === "delete" ? (
        <p className="w-full text-sm">
          Delete space “{spaceName}”? Projects and threads are not affected.
        </p>
      ) : (
        <input
          ref={inputRef}
          aria-label="Space name"
          autoFocus
          placeholder="Space name"
          maxLength={SPACE_NAME_MAX}
          value={name}
          readOnly={saving}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      )}
      <button
        ref={submitRef}
        type="submit"
        disabled={saving || (edit !== "delete" && !trimmed)}
        className={`${buttonClass} ${edit === "delete" ? "text-destructive" : ""}`}
      >
        {saving ? "Saving…" : edit === "delete" ? "Delete" : "Save"}
      </button>
      <button
        type="button"
        disabled={saving}
        onClick={onClose}
        className={buttonClass}
      >
        Cancel
      </button>
      {error && (
        <p role="alert" className="w-full text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
