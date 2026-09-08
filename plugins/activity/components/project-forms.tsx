import { useState } from "react";
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { projectContract } from "../lib/project-contract";
import { PROJECT_NAME_MAX, type ManagedProject } from "../lib/project-schema";
import { InlineForm, NameField } from "./inline-form";
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
