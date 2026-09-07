import { useState } from "react";
import { SPACE_NAME_MAX } from "../lib/space-schema";
import { InlineForm, NameField } from "./inline-form";
import type { SpaceEdit } from "./scope-menu";

// Creating, renaming, and deleting a space share one inline form. The caller
// performs the save so it can also update the selection.
export function SpaceForm({
  edit,
  spaceName,
  hint,
  onSubmit,
  onClose,
}: {
  edit: SpaceEdit;
  /** The selected space's name for rename and delete. */
  spaceName?: string;
  /** What a new space starts with. */
  hint?: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(edit === "rename" ? (spaceName ?? "") : "");
  const trimmed = name.trim();
  if (edit === "delete")
    return (
      <InlineForm
        label="Delete space"
        submitLabel="Delete"
        destructive
        onSubmit={() => onSubmit("")}
        onClose={onClose}
      >
        <p className="w-full text-sm">
          Delete space “{spaceName}”? Projects and threads are not affected.
        </p>
      </InlineForm>
    );
  return (
    <InlineForm
      label={edit === "create" ? "New space" : "Rename space"}
      submitLabel={edit === "create" ? "Create" : "Save"}
      canSubmit={trimmed.length > 0}
      hint={hint}
      onSubmit={() => onSubmit(trimmed)}
      onClose={onClose}
    >
      <NameField
        label="Space name"
        value={name}
        max={SPACE_NAME_MAX}
        onChange={setName}
      />
    </InlineForm>
  );
}
