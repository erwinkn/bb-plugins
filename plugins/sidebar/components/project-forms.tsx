import { useState } from "react";
import { PROJECT_NAME_MAX, type ManagedProject } from "../lib/project-schema";
import { formInputClass, InlineForm, NameField } from "./inline-form";

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
