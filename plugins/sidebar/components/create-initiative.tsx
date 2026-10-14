import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { usePortalScopeProps } from "../lib/portal-scope";
import { HostIcon } from "../lib/host-icon";
import { formButtonClass, formInputClass } from "./inline-form";
import type { InitiativeDraft } from "../lib/initiative-submissions";

/**
 * The New initiative dialog: a name, what it should achieve, and its
 * repositories. Submitting hands the draft back at once; the section creates
 * it in the background and shows its progress in the list.
 */
export function CreateInitiativeDialog({
  draft,
  projects,
  onSubmit,
  onClose,
}: {
  /** The draft to edit; null keeps the dialog closed. */
  draft: InitiativeDraft | null;
  projects: readonly { id: string; name: string }[];
  onSubmit: (draft: InitiativeDraft) => void;
  onClose: () => void;
}) {
  const scope = usePortalScopeProps();
  return (
    <Dialog.Root open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay {...scope} className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          {...scope}
          aria-describedby={undefined}
          className="fixed left-1/2 top-[12vh] z-50 flex max-h-[76vh] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-xl border border-border bg-popover text-popover-foreground shadow-xl outline-none"
        >
          {draft && (
            <DraftForm
              draft={draft}
              projects={projects}
              onSubmit={onSubmit}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DraftForm({
  draft,
  projects,
  onSubmit,
}: {
  draft: InitiativeDraft;
  projects: readonly { id: string; name: string }[];
  onSubmit: (draft: InitiativeDraft) => void;
}) {
  const [name, setName] = useState(draft.name);
  const [objective, setObjective] = useState(draft.objective);
  const [members, setMembers] = useState(draft.memberProjectIds);
  const ready = name.trim() && objective.trim() && members.length > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    onSubmit({
      ...draft,
      name: name.trim(),
      objective: objective.trim(),
      memberProjectIds: members,
    });
  };
  return (
    <form
      aria-label="New initiative"
      onSubmit={submit}
      className="flex min-h-0 flex-col gap-3 p-4"
    >
      <div className="flex items-center gap-2">
        <Dialog.Title className="m-0 flex-1 text-sm font-medium">
          New initiative
        </Dialog.Title>
        <Dialog.Close
          aria-label="Close"
          className="flex size-6 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HostIcon name="X" className="size-3.5" />
        </Dialog.Close>
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Name
        <input
          autoFocus
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          className={`${formInputClass} text-foreground`}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        What should it achieve?
        <textarea
          value={objective}
          rows={3}
          maxLength={4000}
          onChange={(event) => setObjective(event.target.value)}
          className={`${formInputClass} resize-y text-foreground`}
        />
      </label>
      <fieldset className="m-0 flex min-h-0 flex-col gap-1 border-0 p-0">
        <legend className="mb-1 p-0 text-xs text-muted-foreground">
          Repositories
        </legend>
        <ul className="m-0 min-h-0 max-h-48 list-none overflow-y-auto rounded-md border border-border p-1">
          {projects.map((project) => {
            const checked = members.includes(project.id);
            return (
              <li key={project.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setMembers((list) =>
                        checked
                          ? list.filter((id) => id !== project.id)
                          : [...list, project.id],
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {members[0] === project.id && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      Coordinator
                    </span>
                  )}
                </label>
              </li>
            );
          })}
          {!projects.length && (
            <li className="px-2 py-1 text-xs text-muted-foreground">
              No projects yet.
            </li>
          )}
        </ul>
        <p className="m-0 text-xs text-muted-foreground">
          The coordinator starts in the first repository’s default checkout.
        </p>
      </fieldset>
      <div className="flex justify-end gap-2">
        <Dialog.Close type="button" className={formButtonClass}>
          Cancel
        </Dialog.Close>
        <button
          type="submit"
          disabled={!ready}
          className={`${formButtonClass} bg-foreground text-background hover:bg-foreground/90`}
        >
          Create initiative
        </button>
      </div>
    </form>
  );
}
