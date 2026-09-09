import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { PromptRole } from "./prompt-store";
import { Button } from "./components/ui/button";

export function PromptEditor({ role = "live" }: { role?: PromptRole }) {
  const rpc = useRpc<typeof rpcContract>();
  const [active, setActive] = useState<string | null>(null);
  const [defaults, setDefaults] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const current = useRef({ active: null as string | null, draft: "" });
  const generation = useRef(0);
  const label = role === "live" ? "Live model prompt" : role === "worker" ? "Worker prompt" : "Coordinator prompt";
  const limit = role === "coordinator" ? 4096 : 32000;
  const refresh = useCallback(() => {
    const request = ++generation.current;
    void rpc.call("getPrompt", { role }).then(
      (result) => {
        if (request !== generation.current) return;
        if (
          current.current.active === null ||
          current.current.draft === current.current.active
        ) {
          current.current.draft = result.content;
          setDraft(result.content);
        }
        current.current.active = result.content;
        setActive(result.content);
        setDefaults(result.defaultContent);
        setError(null);
      },
      (cause) => {
        if (request === generation.current) setError(String(cause));
      },
    );
  }, [rpc, role]);
  useEffect(() => {
    refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  useRealtime("prompt-changed", refresh);
  const edit = (text: string) => {
    current.current.draft = text;
    setDraft(text);
    setSaved(false);
  };
  async function save() {
    setBusy(true);
    generation.current++;
    const content = draft;
    try {
      await rpc.call("setPrompt", {
        role,
        content,
        source: "user",
        note: "edited in settings",
      });
      current.current.active = content;
      setActive(content);
      setSaved(true);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3 min-w-0">
      <label className="block space-y-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">
          This complete role prompt is sent exactly as shown. Tool descriptions,
          playback instructions, and session context are supplied separately.{" "}
          {role === "live"
            ? "Changes apply to the next call."
            : "Changes apply when BB next configures the coordinator; a new conversation uses the saved prompt."}
        </span>
        <textarea
          aria-label={label}
          value={draft}
          rows={18}
          disabled={active === null || busy}
          onChange={(event) => edit(event.target.value)}
          className="block w-full min-w-0 resize-y rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed text-foreground"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={
            busy ||
            active === null ||
            draft === active ||
            !draft.trim() ||
            draft.length > limit
          }
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || active === null || draft === active}
          onClick={() => edit(active!)}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || active === null || draft === defaults}
          onClick={() => edit(defaults)}
        >
          Restore default
        </Button>
        <span
          className={`text-xs ${draft.length > limit ? "text-destructive" : "text-muted-foreground"}`}
        >
          {draft.length.toLocaleString()} / {limit.toLocaleString()} characters
        </span>
        {saved ? (
          <span role="status" className="text-xs text-muted-foreground">
            Saved
          </span>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="text-sm text-destructive">
          {error} <button onClick={refresh}>Retry loading</button>
        </div>
      ) : null}
    </section>
  );
}
