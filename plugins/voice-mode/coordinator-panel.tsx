// Read-only transcript of the coordinator recorded for an earlier session.
import React from "react";
import { ThreadChat } from "@get-bb/plugin-sdk/app";

export function CoordinatorCard({ threadId }: { threadId: string }) {
  return <section aria-label="Voice coordinator" className="space-y-3 rounded-lg border border-border bg-card px-3.5 py-3">
    <p className="text-sm text-muted-foreground">Coordinator history. This thread is no longer used by Voice Mode.</p>
    <div className="h-[65vh] min-h-80 overflow-hidden rounded-md border border-border" aria-label="Coordinator thread">
      <ThreadChat threadId={threadId} variant="timeline" />
    </div>
  </section>;
}
