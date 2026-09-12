import { useEffect } from "react";
import { useComposerView } from "@get-bb/plugin-sdk/app";
import { recordDraft } from "../lib/client-state";

// Observe text AND attachment-only drafts without reading private host storage
// or saving any prompt content. The bare banner renders no visible content.
export function DraftObserver() {
  const { scope, draft } = useComposerView();
  const key =
    scope.kind === "thread"
      ? `thread:${scope.threadId}`
      : scope.kind === "new-thread" && scope.projectId
        ? `new:${scope.projectId}`
        : null;
  const present = !draft.isEmpty || draft.attachmentCount > 0;
  useEffect(() => {
    if (key) recordDraft(key, present);
  }, [key, present]);
  return null;
}
