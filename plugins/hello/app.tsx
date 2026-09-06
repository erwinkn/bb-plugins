import { useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "./components/ui/button";

function HelloPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState(false);
  const [reply, setReply] = useState<{ message: string; serverTime: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ping() {
    if (pending) return;
    setPending(true);
    setReply(null);
    setError(null);
    try {
      setReply(await rpc.call("ping", null));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request failed. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto w-full max-w-lg space-y-4 p-4 text-foreground">
        <h1 className="text-xl font-semibold">Erwin Hello</h1>
        <p className="text-sm text-muted-foreground">Send a request to the BB server.</p>
        <Button type="button" disabled={pending} onClick={ping}>
          {pending ? "Waiting for the server…" : "Say hello"}
        </Button>
        <div role="status" aria-live="polite" className="space-y-2 break-words text-sm">
          {reply && <>
            <p>{reply.message}</p>
            <p className="text-muted-foreground">Server time: <time dateTime={reply.serverTime}>{reply.serverTime}</time></p>
          </>}
        </div>
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      </main>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "hello",
    title: "Erwin Hello",
    icon: "Zap",
    path: "hello",
    component: HelloPage,
  });
});
