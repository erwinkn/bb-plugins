import { useState } from "react";
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { projectContract } from "../lib/project-contract";
import {
  folderName,
  PROJECT_NAME_MAX,
  type ProjectHost,
} from "../lib/project-schema";
import {
  Modal,
  modalButtonClass,
  modalInputClass,
  modalPrimaryClass,
} from "./modal";
import { PathField } from "./path-field";

function useSubmit(onSubmit: () => Promise<void>, onClose: () => void) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit();
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The change was not saved.",
      );
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, setError, submit };
}

export function AddProjectDialog({
  rpc,
  hosts,
  defaultHostId,
  spaceName,
  compact,
  onSubmit,
  onClose,
}: {
  rpc: PluginRpcClient<typeof projectContract>;
  hosts: readonly ProjectHost[];
  defaultHostId: string | null;
  /** The space the new project joins, if one is being edited. */
  spaceName?: string;
  compact: boolean;
  onSubmit: (input: {
    name: string;
    hostId: string;
    path: string;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [hostId, setHostId] = useState(defaultHostId ?? "");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const trimmedPath = path.trim().replace(/\/+$/, "") || path.trim();
  const shownName = nameTouched ? name : folderName(trimmedPath);
  const effectiveName = shownName.trim();
  const canSubmit =
    hostId.length > 0 && trimmedPath.length > 0 && effectiveName.length > 0;
  const { saving, error, setError, submit } = useSubmit(
    () => onSubmit({ name: effectiveName, hostId, path: trimmedPath }),
    onClose,
  );
  return (
    <Modal
      open
      onClose={onClose}
      title="Add project"
      description={
        spaceName
          ? `The project joins ${spaceName}.`
          : "Pick the folder that holds the repository."
      }
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
            form="add-project-dialog"
            disabled={saving || !canSubmit}
            className={modalPrimaryClass}
          >
            {saving ? "Adding…" : "Add"}
          </button>
        </>
      }
    >
      <form
        id="add-project-dialog"
        aria-label="Add project"
        onSubmit={submit}
        className="flex flex-col gap-3 p-4"
      >
        {hosts.length > 1 && (
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              Host
            </span>
            <select
              aria-label="Host"
              value={hostId}
              onChange={(event) => setHostId(event.target.value)}
              className={modalInputClass}
            >
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name}
                  {host.connected ? "" : " (offline)"}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">
            Folder
          </span>
          <PathField
            rpc={rpc}
            hostId={hostId}
            value={path}
            autoFocus
            onChange={setPath}
            onError={setError}
          />
        </div>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">Name</span>
          <input
            aria-label="Project name"
            placeholder="Project name"
            maxLength={PROJECT_NAME_MAX}
            value={shownName}
            onChange={(event) => {
              setNameTouched(true);
              setName(event.target.value);
            }}
            className={modalInputClass}
          />
        </label>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

export function RemoveProjectDialog({
  projectName,
  threadCount,
  compact,
  onSubmit,
  onClose,
}: {
  projectName: string;
  threadCount: number;
  compact: boolean;
  onSubmit: () => Promise<void>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const { saving, error, submit } = useSubmit(onSubmit, onClose);
  const canSubmit = typed.trim() === projectName;
  const threads =
    threadCount === 1
      ? "its 1 active thread"
      : `its ${threadCount} active threads`;
  return (
    <Modal
      open
      onClose={onClose}
      title="Remove project"
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
            form="remove-project-dialog"
            disabled={saving || !canSubmit}
            className={`${modalButtonClass} text-destructive`}
          >
            {saving ? "Removing…" : "Remove"}
          </button>
        </>
      }
    >
      <form
        id="remove-project-dialog"
        aria-label="Remove project"
        onSubmit={(event) => {
          if (!canSubmit) {
            event.preventDefault();
            return;
          }
          void submit(event);
        }}
        className="flex flex-col gap-3 p-4"
      >
        <p className="text-sm">
          Remove “{projectName}”? This deletes the project from BB together with{" "}
          {threads} and its archive. Files on disk are not touched.
        </p>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-muted-foreground">
            Type the project name to confirm
          </span>
          <input
            autoFocus
            aria-label="Type the project name to confirm"
            placeholder={projectName}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
            className={modalInputClass}
          />
        </label>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
