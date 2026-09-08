import { useState } from "react";
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { projectContract } from "../lib/project-contract";
import {
  folderName,
  PROJECT_NAME_MAX,
  type ManagedProject,
  type ProjectHost,
} from "../lib/project-schema";
import { formInputClass, InlineForm, NameField } from "./inline-form";
import { PathField } from "./path-field";

// Edit-in-place forms for one project row or group header.
export function ProjectRenameForm({
  project,
  onSubmit,
  onClose,
}: {
  project: Pick<ManagedProject, "name">;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(project.name);
  const trimmed = name.trim();
  return (
    <InlineForm
      label="Rename project"
      submitLabel="Save"
      canSubmit={trimmed.length > 0 && trimmed !== project.name}
      onSubmit={() => onSubmit(trimmed)}
      onClose={onClose}
    >
      <NameField
        label="Project name"
        value={name}
        max={PROJECT_NAME_MAX}
        onChange={setName}
      />
    </InlineForm>
  );
}

export function ProjectFolderForm({
  project,
  source,
  rpc,
  onSubmit,
  onClose,
}: {
  project: Pick<ManagedProject, "name">;
  source: NonNullable<ManagedProject["source"]>;
  rpc: PluginRpcClient<typeof projectContract>;
  onSubmit: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [path, setPath] = useState(source.path);
  const [error, setError] = useState<string | null>(null);
  const trimmed = path.trim().replace(/\/+$/, "") || path.trim();
  return (
    <InlineForm
      label="Change folder"
      submitLabel="Save"
      canSubmit={trimmed.length > 0 && trimmed !== source.path}
      hint={
        error ??
        `Folder for ${project.name} on this host. Threads keep their history.`
      }
      onSubmit={() => onSubmit(trimmed)}
      onClose={onClose}
    >
      <PathField
        rpc={rpc}
        hostId={source.hostId}
        value={path}
        onChange={setPath}
        onError={setError}
      />
    </InlineForm>
  );
}

export function ProjectRemoveForm({
  project,
  threadCount,
  onSubmit,
  onClose,
}: {
  project: Pick<ManagedProject, "name">;
  threadCount: number;
  onSubmit: () => Promise<void>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const threads =
    threadCount === 1
      ? "its 1 active thread"
      : `its ${threadCount} active threads`;
  return (
    <InlineForm
      label="Remove project"
      submitLabel="Remove"
      destructive
      canSubmit={typed.trim() === project.name}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      <p className="w-full text-sm">
        Remove “{project.name}”? This deletes the project from BB together with{" "}
        {threads} and its archive. Files on disk are not touched.
      </p>
      <input
        aria-label="Type the project name to confirm"
        placeholder={project.name}
        value={typed}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setTyped(event.target.value)}
        className={formInputClass}
      />
    </InlineForm>
  );
}

export function AddProjectForm({
  rpc,
  hosts,
  defaultHostId,
  hint,
  onSubmit,
  onClose,
}: {
  rpc: PluginRpcClient<typeof projectContract>;
  hosts: readonly ProjectHost[];
  defaultHostId: string | null;
  hint?: string;
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
  const [error, setError] = useState<string | null>(null);
  const trimmedPath = path.trim().replace(/\/+$/, "") || path.trim();
  const shownName = nameTouched ? name : folderName(trimmedPath);
  const effectiveName = shownName.trim();
  return (
    <InlineForm
      label="Add project"
      submitLabel="Add"
      canSubmit={
        hostId.length > 0 && trimmedPath.length > 0 && effectiveName.length > 0
      }
      hint={error ?? hint}
      onSubmit={() =>
        onSubmit({ name: effectiveName, hostId, path: trimmedPath })
      }
      onClose={onClose}
    >
      {hosts.length > 1 && (
        <select
          aria-label="Host"
          value={hostId}
          onChange={(event) => setHostId(event.target.value)}
          className={formInputClass}
        >
          {hosts.map((host) => (
            <option key={host.id} value={host.id}>
              {host.name}
              {host.connected ? "" : " (offline)"}
            </option>
          ))}
        </select>
      )}
      <div className="flex w-full items-center gap-2">
        <PathField
          rpc={rpc}
          hostId={hostId}
          value={path}
          onChange={setPath}
          onError={setError}
        />
      </div>
      <NameField
        label="Project name"
        value={shownName}
        max={PROJECT_NAME_MAX}
        onChange={(value) => {
          setNameTouched(true);
          setName(value);
        }}
      />
    </InlineForm>
  );
}
