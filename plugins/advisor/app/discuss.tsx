// Discuss a finding in a separate BB thread. The composer is BB's own, seeded
// with the finding as an editable draft; the thread is created, and an agent
// starts, only when you submit. A finding keeps one discussion: once opened,
// Discuss takes you back to it.

import { useEffect, useState } from "react";
import { experimental_NewThreadComposer as NewThreadComposer, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Empty, errorText } from "./ui";

export function DiscussView({ occurrenceId, onBack }: { occurrenceId: string; onBack: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [draft, setDraft] = useState<{ prompt: string; projectId: string | null; threadId: string | null; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("discussDraft", { occurrenceId }).then(setDraft, (e) => setError(errorText(e)));
  }, [rpc, occurrenceId]);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <Icon name="ChevronLeft" className="size-4" />
          Findings
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-base font-medium">{draft?.title ?? "Discuss a finding"}</h2>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {!draft && !error ? <Empty>Loading…</Empty> : null}
      {draft?.threadId ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">This finding already has a discussion thread.</p>
          <Button size="sm" onClick={() => nav.toThread(draft.threadId!)}>
            Open discussion
          </Button>
        </div>
      ) : null}
      {draft && !draft.threadId ? (
        <>
          <p className="text-sm text-muted-foreground">
            The finding is filled in below as a draft. Edit it, pick the model and workspace, and submit to start a separate thread. Nothing is sent before you submit, and the watched thread is never messaged.
          </p>
          <div className="min-h-64 flex-1">
            <NewThreadComposer
              {...(draft.projectId ? { defaultProjectId: draft.projectId } : {})}
              initialPrompt={draft.prompt}
              draftKey={`advisor:discuss:${occurrenceId}`}
              focusRequest={1}
              onSubmit={async (request) => {
                const r = await rpc.call("discussCreate", { occurrenceId, request: request as never });
                nav.toThread(r.threadId);
              }}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
