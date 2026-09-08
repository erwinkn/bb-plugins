import { useState } from "react";
import { SPACE_NAME_MAX, type Space } from "../lib/space-schema";
import { toggleValue } from "../lib/client-state";
import type { ScopeProject } from "../lib/spaces";
import {
  Modal,
  modalButtonClass,
  modalInputClass,
  modalPrimaryClass,
} from "./modal";

export type SpaceDialogKind = "create" | "rename" | "delete";

// Every space edit is a small dialog: create asks for a name and the member
// projects, rename for a name, delete for confirmation.
export function SpaceDialog({
  kind,
  space,
  projects,
  initialProjectIds = [],
  compact,
  onSubmit,
  onClose,
}: {
  kind: SpaceDialogKind;
  /** The space being renamed or deleted. */
  space?: Space;
  projects: readonly ScopeProject[];
  /** Pre-checked projects for a new space. */
  initialProjectIds?: readonly string[];
  compact: boolean;
  onSubmit: (input: { name: string; projectIds: string[] }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(
    kind === "rename" ? (space?.name ?? "") : "",
  );
  const [projectIds, setProjectIds] = useState<string[]>([
    ...initialProjectIds,
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const canSubmit = kind === "delete" || trimmed.length > 0;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || !canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ name: trimmed, projectIds });
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The change was not saved.",
      );
    } finally {
      setSaving(false);
    }
  };
  const title =
    kind === "create"
      ? "New space"
      : kind === "rename"
        ? "Rename space"
        : "Delete space";
  const formId = `space-dialog-${kind}`;
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      compact={compact}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className={modalButtonClass}
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            disabled={saving || !canSubmit}
            className={
              kind === "delete"
                ? `${modalButtonClass} text-destructive`
                : modalPrimaryClass
            }
          >
            {saving
              ? "Saving…"
              : kind === "create"
                ? "Create"
                : kind === "rename"
                  ? "Save"
                  : "Delete"}
          </button>
        </>
      }
    >
      <form id={formId} aria-label={title} onSubmit={submit} className="p-4">
        {kind === "delete" ? (
          <p className="text-sm">
            Delete space “{space?.name}”? Projects and threads are not affected.
          </p>
        ) : (
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              Name
            </span>
            <input
              autoFocus
              aria-label="Space name"
              placeholder="Space name"
              maxLength={SPACE_NAME_MAX}
              value={name}
              readOnly={saving}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setName(event.target.value)}
              className={modalInputClass}
            />
          </label>
        )}
        {kind === "create" && (
          <fieldset className="mt-4">
            <legend className="mb-1 text-xs text-muted-foreground">
              Projects
            </legend>
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No projects yet. Add them from Manage spaces and projects.
              </p>
            ) : (
              <ul className="m-0 max-h-64 list-none overflow-y-auto rounded-md border border-border p-1">
                {projects.map((project) => (
                  <li key={project.id}>
                    <label className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
                      <input
                        type="checkbox"
                        checked={projectIds.includes(project.id)}
                        disabled={saving}
                        onChange={() =>
                          setProjectIds((ids) => toggleValue(ids, project.id))
                        }
                        className="size-3.5"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {project.name}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              {projectIds.length === 0
                ? "An empty space shows no threads until projects are added."
                : `${projectIds.length} of ${projects.length} selected.`}
            </p>
          </fieldset>
        )}
        {error && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
